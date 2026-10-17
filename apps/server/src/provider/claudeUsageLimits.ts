// @effect-diagnostics-next-line nodeBuiltinImport:off -- Scope IDs require a synchronous digest.
import * as NodeCrypto from "node:crypto";

import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  TrimmedNonEmptyString,
  type ProviderUsageLimitsUpdate,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const OVERAGE_INCLUDED_EVENT_TYPE = "seven_day_overage_included";
const FAMILY_LABELS = { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" } as const;
const isUtilization = Schema.is(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)));
const decodeModelScopedWindows = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));
const decodeModelScopedWindow = Schema.decodeUnknownOption(
  Schema.Struct({
    display_name: TrimmedNonEmptyString,
    utilization: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    resets_at: Schema.NullOr(Schema.String),
  }),
);
const decodeWindow = Schema.decodeUnknownOption(
  Schema.Struct({
    utilization: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    resets_at: Schema.NullOr(Schema.String),
  }),
);

/** Each configured instance owns a separate reference for the event target. */
export interface ClaudeScopedLimitNames {
  readonly overageIncluded: string | undefined;
}

export const makeClaudeScopedLimitNames = Ref.make<ClaudeScopedLimitNames>({
  overageIncluded: undefined,
});

function scopedIdentity(
  displayName: string,
): Pick<ServerProviderUsageWindow, "id" | "label" | "modelFamily"> {
  const match = /^(?:claude[ -])?(fable|opus|sonnet|haiku)(?:[ -](\d+(?:\.\d+)*))?$/i.exec(
    displayName.trim(),
  );
  if (match) {
    const family = match[1]!.toLowerCase() as keyof typeof FAMILY_LABELS;
    const version = match[2];
    return {
      id: `seven_day_${family}${version ? `_${version.replaceAll(".", "_")}` : ""}`,
      label: `Weekly · ${FAMILY_LABELS[family]}${version ? ` ${version}` : ""}`,
      modelFamily: `claude-${family}`,
    };
  }
  return {
    id: `seven_day_unrecognized_${NodeCrypto.createHash("sha256").update(displayName).digest("hex")}`,
    label: "Weekly · Unrecognized model",
    modelFamily: "unrecognized",
  };
}

function scopedWindow(
  displayName: string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  return {
    ...scopedIdentity(displayName),
    kind: "weekly",
    windowDurationMins: WEEK_MINS,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function isoFromEpochSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function isoFromString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function makeWindow(
  id: string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow | undefined {
  if (id === "five_hour" || id === "seven_day") {
    return {
      id,
      kind: id === "five_hour" ? "session" : "weekly",
      label: id === "five_hour" ? "Session" : "Weekly",
      windowDurationMins: id === "five_hour" ? SESSION_MINS : WEEK_MINS,
      usedPercent: clampPercent(usedPercent),
      ...(resetsAt ? { resetsAt } : {}),
    };
  }
  if (id === OVERAGE_INCLUDED_EVENT_TYPE) {
    return { ...scopedWindow("overage_included", usedPercent, resetsAt), id };
  }
  if (id.startsWith("seven_day_")) {
    return scopedWindow(id.slice("seven_day_".length), usedPercent, resetsAt);
  }
  return undefined;
}

/** Runtime utilization uses fractions. Unknown model scopes remain visible. */
export function claudeRateLimitEventToUpdate(
  info: SDKRateLimitInfo,
  names: ClaudeScopedLimitNames,
  checkedAt: string,
): ProviderUsageLimitsUpdate | undefined {
  const type = info.rateLimitType;
  const usedPercent = isUtilization(info.utilization)
    ? Math.min(1, info.utilization) * 100
    : undefined;
  const resetsAt = isoFromEpochSeconds(info.resetsAt);
  const window =
    type && usedPercent !== undefined
      ? type === OVERAGE_INCLUDED_EVENT_TYPE && names.overageIncluded
        ? scopedWindow(names.overageIncluded, usedPercent, resetsAt)
        : makeWindow(type, usedPercent, resetsAt)
      : undefined;
  const reason = info.overageDisabledReason;
  const failed = reason === "fetch_error" || reason === "unknown";
  const disabled = reason !== undefined && !failed && reason !== "out_of_credits";
  const rejected =
    info.overageStatus === "rejected" || (type === "overage" && info.status === "rejected");
  const allowed =
    info.overageStatus === "allowed" ||
    info.overageStatus === "allowed_warning" ||
    info.isUsingOverage === true ||
    info.overageInUse === true ||
    (type === "overage" && info.status !== "rejected");
  const hasExtraUsage =
    reason !== undefined || info.overageStatus !== undefined || allowed || type === "overage";
  if (!window && !hasExtraUsage) return undefined;
  return {
    windows: window ? [window] : [],
    ...(hasExtraUsage
      ? {
          extraUsage: {
            checkedAt,
            enabled: disabled ? false : failed || !allowed ? null : true,
            available:
              disabled ||
              reason === "out_of_credits" ||
              rejected ||
              (type === "overage" && usedPercent === 100)
                ? false
                : failed
                  ? null
                  : allowed
                    ? true
                    : null,
            coversModelLimits: true,
            ...(type === "overage" && usedPercent !== undefined ? { usedPercent } : {}),
          },
        }
      : {}),
  };
}

/** Probe utilization already uses percentages. */
export function claudeUsageResponseToLimits(input: {
  readonly response: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
  readonly checkedAt: string;
}): { readonly limits: ServerProviderUsageLimits; readonly names: ClaudeScopedLimitNames } {
  const { response, checkedAt } = input;
  if (!response.rate_limits_available || !response.rate_limits) {
    return {
      limits: makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" }),
      names: { overageIncluded: undefined },
    };
  }
  const windows: ServerProviderUsageWindow[] = [];
  for (const [id, raw] of Object.entries(response.rate_limits)) {
    const decoded = decodeWindow(raw);
    if (Option.isNone(decoded)) continue;
    const window = makeWindow(
      id,
      decoded.value.utilization,
      isoFromString(decoded.value.resets_at),
    );
    if (window) windows.push(window);
  }
  const scopedNames: string[] = [];
  const modelScoped = decodeModelScopedWindows(response.rate_limits.model_scoped);
  for (const raw of Option.getOrElse(modelScoped, () => [])) {
    const decoded = decodeModelScopedWindow(raw);
    if (Option.isNone(decoded)) continue;
    const entry = decoded.value;
    windows.push(
      scopedWindow(entry.display_name, entry.utilization, isoFromString(entry.resets_at)),
    );
    scopedNames.push(entry.display_name);
  }
  // The event carries no model name. Fable is the known overage-included family.
  // A single scoped bucket is unambiguous; multiple other buckets are unknown.
  const fableNames = scopedNames.filter(
    (name) => scopedIdentity(name).modelFamily === "claude-fable",
  );
  const overageIncluded =
    fableNames.length === 1 ? fableNames[0] : scopedNames.length === 1 ? scopedNames[0] : undefined;
  return {
    limits: {
      ...makeUsageLimits({ checkedAt, windows }),
      ...(response.rate_limits.extra_usage
        ? {
            extraUsage: {
              checkedAt,
              enabled: response.rate_limits.extra_usage.is_enabled,
              // A remaining spend cap does not prove that prepaid funds are available.
              available:
                !response.rate_limits.extra_usage.is_enabled ||
                response.rate_limits.extra_usage.monthly_limit === 0 ||
                (isUtilization(response.rate_limits.extra_usage.utilization) &&
                  response.rate_limits.extra_usage.utilization >= 100) ||
                (isUtilization(response.rate_limits.extra_usage.monthly_limit) &&
                  isUtilization(response.rate_limits.extra_usage.used_credits) &&
                  response.rate_limits.extra_usage.used_credits >=
                    response.rate_limits.extra_usage.monthly_limit)
                  ? false
                  : null,
              coversModelLimits: true,
              ...(isUtilization(response.rate_limits.extra_usage.utilization)
                ? { usedPercent: clampPercent(response.rate_limits.extra_usage.utilization) }
                : {}),
            },
          }
        : {}),
    },
    names: { overageIncluded },
  };
}

export const recordClaudeUsageResponse = (
  namesRef: Ref.Ref<ClaudeScopedLimitNames>,
  input: Parameters<typeof claudeUsageResponseToLimits>[0],
): Effect.Effect<ServerProviderUsageLimits> => {
  const { limits, names } = claudeUsageResponseToLimits(input);
  return Ref.set(namesRef, names).pipe(Effect.as(limits));
};
