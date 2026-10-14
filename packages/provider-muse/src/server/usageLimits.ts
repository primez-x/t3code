import type { ProviderUsageLimitsUpdate } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { clampPercent } from "@t3tools/provider-core/server/usageLimits";

const Percent = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Timestamp = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 8.64e15 }));
const decodeSubscriptionUsage = Schema.decodeUnknownOption(
  Schema.Struct({
    observedAtMs: Timestamp,
    window: Schema.Struct({
      usedPercent: Percent,
      windowDurationMins: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      resetsAtMs: Timestamp,
    }),
    weekly: Schema.Struct({
      usedPercent: Percent,
      resetsAtMs: Timestamp,
    }),
  }),
);

/** Preserve the host observation time, including stale observations. */
export function museSubscriptionUsageToUpdate(
  usage: unknown,
): (ProviderUsageLimitsUpdate & { readonly checkedAt: string }) | undefined {
  const decoded = decodeSubscriptionUsage(usage);
  if (Option.isNone(decoded)) return undefined;
  const observation = decoded.value;
  return {
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(observation.observedAtMs)),
    windows: [
      {
        id: "window",
        kind: "session",
        label: "Session",
        usedPercent: clampPercent(observation.window.usedPercent),
        windowDurationMins: observation.window.windowDurationMins,
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(observation.window.resetsAtMs)),
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: clampPercent(observation.weekly.usedPercent),
        windowDurationMins: 7 * 24 * 60,
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(observation.weekly.resetsAtMs)),
      },
    ],
  };
}
