import { invalidOptionSelections } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  DelegationCapability,
  DelegationTaskRole,
  RuntimeMode,
  type DelegationModelRoute,
  type DelegationRoutingDecision,
  type DelegationPolicy,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderOptionSelection,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";

export class DelegationSelectionError extends Schema.TaggedError<DelegationSelectionError>()(
  "DelegationSelectionError",
  {
    category: Schema.Literals(["no-candidate", "advisor-unavailable"]),
    capability: DelegationCapability,
    role: DelegationTaskRole,
    requestedModel: Schema.optionalKey(Schema.String),
    unavailableReason: Schema.optionalKey(
      Schema.Literals(["provider-unavailable", "usage-exhausted"]),
    ),
    runtimeMode: Schema.optionalKey(RuntimeMode),
    constraint: Schema.optionalKey(Schema.Literal("astra-fallback-only")),
  },
) {
  override get message(): string {
    if (this.constraint === "astra-fallback-only")
      return "Astra requires an unavailable, exhausted, or excluded Claude advisor. No substitute was selected.";
    const runtime = this.runtimeMode ? ` Runtime mode: "${this.runtimeMode}".` : "";
    if (this.requestedModel !== undefined)
      return `Requested model "${this.requestedModel}" cannot run role "${this.role}" at capability "${this.capability}". Check availability, quota, reviewer exclusions, routes, and effort. No substitute was selected.${runtime}`;
    return this.category === "advisor-unavailable"
      ? "The preferred Claude advisor is unavailable. Astra requires an unavailable, exhausted, or excluded Claude advisor."
      : `No available provider model satisfies capability "${this.capability}" for role "${this.role}" within configured route and option limits.${runtime}`;
  }
}

export interface DelegationSelectionInput {
  readonly policy: DelegationPolicy;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly parent: ModelSelection;
  readonly rootModel: string;
  readonly capability: DelegationCapability;
  readonly role: DelegationTaskRole;
  readonly nowMs: number;
  readonly runtimeMode?: RuntimeMode;
  readonly excludedReviewerModels?: ReadonlyArray<string>;
  readonly activeAssignments?: ReadonlyArray<ModelSelection>;
  readonly allowedProviderInstanceIds?: ReadonlyArray<ProviderInstanceId>;
  readonly requestedTarget?: {
    readonly instanceId?: ProviderInstanceId | undefined;
    readonly driver?: ProviderDriverKind | undefined;
    readonly model?: string;
    readonly options?: ReadonlyArray<ProviderOptionSelection>;
  };
  readonly hiddenModelsByInstance?: Readonly<Record<string, ReadonlyArray<string>>>;
}

export type DelegationSelectionDecision = DelegationRoutingDecision;

export type DelegationSelectionResult =
  | {
      readonly ok: true;
      readonly modelSelection: ModelSelection;
      readonly decision: DelegationSelectionDecision;
    }
  | { readonly ok: false; readonly error: DelegationSelectionError };

interface Quota {
  readonly headroomPercent: number | null;
  readonly usesCredits?: boolean;
  readonly usageCheckedAt: string | null;
}

interface Candidate {
  readonly provider: ServerProvider;
  readonly model: ServerProviderModel;
  readonly route: DelegationModelRoute;
  readonly routeIndex: number;
  readonly options: ReadonlyArray<ProviderOptionSelection>;
  readonly quota: Quota;
  readonly activeCount: number;
}

const unknownQuota: Quota = { headroomPercent: null, usageCheckedAt: null };
const effortIds = new Set(["effort", "reasoningEffort"]);
const allowedEfforts = new Set(["low", "medium", "high", "xhigh"]);
function matchesModel(route: DelegationModelRoute, model: ServerProviderModel): boolean {
  if (route.model.endsWith("-*"))
    return !model.isLegacy && isFamily(model.slug, route.model.slice(0, -2));
  return route.model === model.slug || model.aliases?.includes(route.model) === true;
}

function isFamily(model: string, family: string): boolean {
  return model === family || model.startsWith(`${family}-`);
}

function isAstraModel(model: ServerProviderModel): boolean {
  return [model.slug, ...(model.aliases ?? [])].some((id) =>
    /(?:^|\/)gpt-\d+(?:\.\d+)?-astra(?:-|$)/.test(id),
  );
}

function applicableWindow(window: ServerProviderUsageWindow, model: string): boolean {
  if ("modelFamily" in window && typeof window.modelFamily === "string") {
    return isFamily(model, window.modelFamily) || isFamily(model, `claude-${window.modelFamily}`);
  }
  const scope = /^seven_day_(opus|sonnet|fable|haiku)$/.exec(window.id)?.[1];
  return scope === undefined || isFamily(model, `claude-${scope}`);
}

function quotaExhausted(quota: Quota): boolean {
  return quota.headroomPercent === 0 && quota.usesCredits !== true;
}

function quotaFor(
  provider: ServerProvider,
  model: string,
  nowMs: number,
  allowCredits: boolean,
): Quota {
  const limits = provider.usageLimits;
  if (!limits || limits.unavailable || !Number.isFinite(nowMs)) return unknownQuota;
  const checked = DateTime.make(limits.checkedAt);
  if (Option.isNone(checked)) return unknownQuota;
  const checkedMs = DateTime.toEpochMillis(checked.value);
  if (checkedMs > nowMs || nowMs - checkedMs > 300_000) return unknownQuota;
  const windows = limits.windows.filter((window) => applicableWindow(window, model));
  if (windows.length === 0) return unknownQuota;
  let headroomPercent = 100;
  let modelExhausted = false;
  let incomplete = limits.windows.some((window) => window.modelFamily === "unrecognized");
  for (const window of windows) {
    const reset = DateTime.make(window.resetsAt ?? "");
    if (
      Option.isNone(reset) ||
      DateTime.toEpochMillis(reset.value) <= nowMs ||
      !Number.isFinite(window.usedPercent) ||
      window.usedPercent < 0 ||
      window.usedPercent > 100
    ) {
      incomplete = true;
      continue;
    }
    if (window.modelFamily !== undefined && window.usedPercent === 100) modelExhausted = true;
    headroomPercent = Math.min(headroomPercent, 100 - window.usedPercent);
  }
  if (incomplete && headroomPercent !== 0) return unknownQuota;
  const credits = limits.credits;
  const creditsCheckedMs = Date.parse(credits?.checkedAt ?? "");
  const usesCredits =
    headroomPercent === 0 &&
    !modelExhausted &&
    provider.driver === "codex" &&
    allowCredits &&
    credits !== undefined &&
    Number.isFinite(creditsCheckedMs) &&
    creditsCheckedMs <= nowMs &&
    nowMs - creditsCheckedMs <= 300_000 &&
    (credits.unlimited ||
      (credits.hasCredits &&
        (credits.balance === undefined ||
          (Number.isFinite(Number(credits.balance)) && Number(credits.balance) > 0))));
  return {
    headroomPercent,
    usageCheckedAt: limits.checkedAt,
    ...(usesCredits ? { usesCredits: true } : {}),
  };
}

function canServe(provider: ServerProvider, input: DelegationSelectionInput): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.availability !== "unavailable" &&
    (provider.status === "ready" || provider.status === "warning") &&
    provider.auth.status !== "unauthenticated" &&
    (!input.allowedProviderInstanceIds ||
      input.allowedProviderInstanceIds.includes(provider.instanceId))
  );
}

function optionsFor(
  model: ServerProviderModel,
  effort: DelegationModelRoute["effort"],
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (!allowedEfforts.has(effort)) return undefined;
  const descriptors =
    model.capabilities?.optionDescriptors?.filter((descriptor) => effortIds.has(descriptor.id)) ??
    [];
  if (descriptors.length === 0) return undefined;
  const options: Array<ProviderOptionSelection> = [];
  for (const descriptor of descriptors) {
    if (descriptor.type !== "select" || !descriptor.options.some((choice) => choice.id === effort))
      return undefined;
    options.push({ id: descriptor.id, value: effort });
  }
  for (const descriptor of model.capabilities?.optionDescriptors ?? []) {
    if (
      descriptor.id === "serviceTier" &&
      descriptor.type === "select" &&
      descriptor.options.some((choice) => choice.id === "default")
    ) {
      options.push({ id: descriptor.id, value: "default" });
    } else if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
      options.push({ id: descriptor.id, value: false });
    }
  }
  return options;
}

/** Select the requested target first, then explain any availability substitution. */
export function selectDelegationTarget(input: DelegationSelectionInput): DelegationSelectionResult {
  const primary = selectDelegationTargetOnce(input);
  if (primary.ok || !input.requestedTarget || !primary.error.unavailableReason) return primary;
  const { requestedTarget, ...automaticInput } = input;
  const substitute = selectDelegationTargetOnce(automaticInput);
  if (!substitute.ok) return primary;
  return {
    ...substitute,
    decision: {
      ...substitute.decision,
      substitution: {
        ...(requestedTarget.model === undefined ? {} : { requestedModel: requestedTarget.model }),
        ...(requestedTarget.instanceId === undefined
          ? {}
          : { requestedProviderInstanceId: requestedTarget.instanceId }),
        ...(requestedTarget.driver === undefined
          ? {}
          : { requestedDriver: requestedTarget.driver }),
        reason:
          primary.error.unavailableReason === "usage-exhausted"
            ? "Requested target has no remaining usage."
            : "Requested provider is unavailable for this task.",
      },
    },
  };
}

function selectDelegationTargetOnce(input: DelegationSelectionInput): DelegationSelectionResult {
  const advisor = input.role === "advice" || input.role === "review";
  const capability = advisor ? "architecture" : input.capability;
  const fail = (
    category: DelegationSelectionError["category"],
    constraint?: "astra-fallback-only",
    unavailableReason?: DelegationSelectionError["unavailableReason"],
  ): DelegationSelectionResult => ({
    ok: false,
    error: new DelegationSelectionError({
      category,
      capability,
      role: input.role,
      ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
      ...(input.requestedTarget?.model !== undefined
        ? { requestedModel: input.requestedTarget.model }
        : {}),
      ...(constraint === undefined ? {} : { constraint }),
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
    }),
  });
  if (
    input.requestedTarget?.options?.some(
      (option) =>
        effortIds.has(option.id) &&
        (typeof option.value !== "string" || !allowedEfforts.has(option.value)),
    )
  )
    return fail("no-candidate");
  const opusRoot = isFamily(input.rootModel, "claude-opus");
  const advisorFamily = opusRoot ? "claude-fable" : "claude-opus";
  const usableProviders = input.providers.filter((provider) => canServe(provider, input));
  const claudeAvailable = usableProviders.some((provider) => {
    if (provider.driver !== "claudeAgent") return false;
    const advisorModels = provider.models.filter(
      (model) => !model.isCustom && isFamily(model.slug, advisorFamily),
    );
    const relevantModels =
      advisorModels.length > 0 ? advisorModels.map((model) => model.slug) : [advisorFamily];
    return relevantModels.some(
      (model) => !quotaExhausted(quotaFor(provider, model, input.nowMs, input.policy.allowCredits)),
    );
  });
  const parentDriver = input.providers.find(
    (provider) => provider.instanceId === input.parent.instanceId,
  )?.driver;
  const excludedModels =
    input.role === "review" ? [input.parent.model, ...(input.excludedReviewerModels ?? [])] : [];
  const excluded = (model: ServerProviderModel) =>
    excludedModels.some(
      (selection) => selection === model.slug || model.aliases?.includes(selection),
    );
  const alternateReview =
    input.role === "review" &&
    claudeAvailable &&
    usableProviders.some(
      (provider) =>
        provider.driver === "claudeAgent" &&
        provider.models.some(
          (model) =>
            !model.isCustom &&
            isFamily(model.slug, advisorFamily) &&
            excluded(model) &&
            !quotaExhausted(quotaFor(provider, model.slug, input.nowMs, input.policy.allowCredits)),
        ),
    );
  const automaticAdvisor = advisor && input.requestedTarget === undefined;
  const fixedAdvisor =
    advisor &&
    (input.requestedTarget
      ? !input.requestedTarget.options?.some((option) => effortIds.has(option.id))
      : !alternateReview);
  const candidates: Array<Candidate> = [];
  const eligibleRequested: Array<{ provider: ServerProvider; model: ServerProviderModel }> = [];
  let requestedAstraBlocked = false;
  input.policy.routes.forEach((route, routeIndex) => {
    if (
      !route.capabilities.includes(capability) ||
      (fixedAdvisor && route.effort !== "high") ||
      input.requestedTarget?.options?.some(
        (option) => effortIds.has(option.id) && option.value !== route.effort,
      )
    )
      return;
    for (const provider of input.providers) {
      if (
        provider.driver !== route.driver ||
        (input.requestedTarget?.instanceId !== undefined &&
          provider.instanceId !== input.requestedTarget.instanceId) ||
        (input.requestedTarget?.driver !== undefined &&
          provider.driver !== input.requestedTarget.driver)
      )
        continue;
      for (const model of provider.models) {
        if (
          !matchesModel(route, model) ||
          excluded(model) ||
          (!model.isCustom &&
            input.hiddenModelsByInstance?.[provider.instanceId]?.includes(model.slug)) ||
          (input.requestedTarget?.model !== undefined &&
            model.slug !== input.requestedTarget.model &&
            !model.aliases?.includes(input.requestedTarget.model))
        )
          continue;
        if (
          advisor &&
          !opusRoot &&
          input.requestedTarget?.model === undefined &&
          isFamily(model.slug, "claude-fable")
        )
          continue;
        const astra = isAstraModel(model);
        if (advisor && astra && claudeAvailable && !alternateReview) {
          if (input.requestedTarget?.model !== undefined) requestedAstraBlocked = true;
          continue;
        }
        if (advisor && astra && route.effort !== "high") continue;
        if (
          automaticAdvisor &&
          !alternateReview &&
          (model.isCustom ||
            (claudeAvailable
              ? provider.driver !== "claudeAgent" || !isFamily(model.slug, advisorFamily)
              : provider.driver !== "codex" || !astra))
        )
          continue;
        const options = optionsFor(model, route.effort);
        if (
          !options ||
          (input.requestedTarget?.options &&
            invalidOptionSelections(
              input.requestedTarget.options,
              model.capabilities?.optionDescriptors,
            ).length > 0)
        )
          continue;
        if (input.requestedTarget) eligibleRequested.push({ provider, model });
        if (!canServe(provider, input)) continue;
        const quota = quotaFor(provider, model.slug, input.nowMs, input.policy.allowCredits);
        if (quotaExhausted(quota)) continue;
        candidates.push({
          provider,
          model,
          route,
          routeIndex,
          options,
          quota,
          activeCount:
            input.activeAssignments?.filter(
              (assignment) => assignment.instanceId === provider.instanceId,
            ).length ?? 0,
        });
      }
    }
  });
  if (candidates.length === 0) {
    if (requestedAstraBlocked) return fail("no-candidate", "astra-fallback-only");
    const servingRequested = eligibleRequested.filter(({ provider }) => canServe(provider, input));
    const unavailableReason =
      eligibleRequested.length > 0 && servingRequested.length === 0
        ? ("provider-unavailable" as const)
        : servingRequested.length > 0 &&
            servingRequested.every(({ provider, model }) =>
              quotaExhausted(
                quotaFor(provider, model.slug, input.nowMs, input.policy.allowCredits),
              ),
            )
          ? ("usage-exhausted" as const)
          : undefined;
    const catalogAdvisor = usableProviders.flatMap((provider) =>
      provider.driver === "claudeAgent"
        ? provider.models.filter((model) => !model.isCustom && isFamily(model.slug, advisorFamily))
        : [],
    );
    const configuredAdvisor = catalogAdvisor.some((model) =>
      input.policy.routes.some(
        (route) =>
          route.driver === "claudeAgent" &&
          route.capabilities.includes(capability) &&
          route.effort === "high" &&
          matchesModel(route, model),
      ),
    );
    return fail(
      automaticAdvisor &&
        claudeAvailable &&
        !alternateReview &&
        (catalogAdvisor.length === 0 || configuredAdvisor)
        ? "advisor-unavailable"
        : "no-candidate",
      undefined,
      unavailableReason,
    );
  }

  // Paid credits keep an exhausted subscription eligible without changing the reported subscription percentage.
  const availableHeadroom = (candidate: Candidate) =>
    candidate.quota.usesCredits ? 100 : candidate.quota.headroomPercent;
  // Filter by a fixed maximum before comparison so tolerance cannot produce cyclic rankings.
  const greatestHeadroom = candidates.reduce(
    (greatest, candidate) =>
      Math.max(greatest, availableHeadroom(candidate) ?? Number.NEGATIVE_INFINITY),
    Number.NEGATIVE_INFINITY,
  );
  const balanced = input.policy.balanceUsage
    ? candidates.filter(
        (candidate) =>
          greatestHeadroom === Number.NEGATIVE_INFINITY ||
          (availableHeadroom(candidate) ?? Number.NEGATIVE_INFINITY) >= greatestHeadroom - 5,
      )
    : candidates;
  const alternateProvider = (candidate: Candidate) =>
    input.policy.preferAlternateProvider &&
    parentDriver !== undefined &&
    candidate.provider.driver !== parentDriver
      ? 1
      : 0;
  const alternateModel = (candidate: Candidate) =>
    input.policy.preferAlternateProvider &&
    candidate.model.slug !== input.parent.model &&
    !candidate.model.aliases?.includes(input.parent.model)
      ? 1
      : 0;
  balanced.sort(
    (left, right) =>
      alternateProvider(right) - alternateProvider(left) ||
      alternateModel(right) - alternateModel(left) ||
      left.route.costPerTask - right.route.costPerTask ||
      left.activeCount - right.activeCount ||
      left.routeIndex - right.routeIndex ||
      left.provider.instanceId.localeCompare(right.provider.instanceId) ||
      left.model.slug.localeCompare(right.model.slug),
  );
  const chosen = balanced[0]!;
  const reason: DelegationSelectionDecision["reason"] = input.requestedTarget
    ? "explicit-target"
    : advisor && (!alternateReview || isAstraModel(chosen.model))
      ? claudeAvailable && !isAstraModel(chosen.model)
        ? opusRoot
          ? "advisor-fable"
          : "advisor-opus"
        : "advisor-fallback"
      : balanced.length < candidates.length
        ? "headroom"
        : alternateProvider(chosen)
          ? "alternate-provider"
          : alternateModel(chosen)
            ? "alternate-model"
            : "lowest-cost";
  return {
    ok: true,
    modelSelection: {
      instanceId: chosen.provider.instanceId,
      model: chosen.model.slug,
      options: chosen.options,
    },
    decision: {
      policyVersion: input.policy.version,
      capability,
      role: input.role,
      reason,
      ...chosen.quota,
    },
  };
}
