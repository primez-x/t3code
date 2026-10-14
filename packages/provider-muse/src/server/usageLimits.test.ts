import { describe, expect, test } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ServerProviderUsageLimits } from "@t3tools/contracts";

import { museSubscriptionUsageToUpdate } from "./usageLimits.ts";

const usage = {
  observedAtMs: Date.parse("2026-07-18T10:00:00Z"),
  tier: "private-subscription-label",
  window: {
    usedPercent: 64,
    windowDurationMins: 300,
    resetsAtMs: Date.parse("2026-07-18T14:00:00Z"),
  },
  weekly: { usedPercent: 25, resetsAtMs: Date.parse("2026-07-24T10:00:00Z") },
};

const isServerProviderUsageLimits = Schema.is(ServerProviderUsageLimits);

describe("museSubscriptionUsageToUpdate", () => {
  test("preserves the native observation time and suppresses private tier data", () => {
    const update = museSubscriptionUsageToUpdate({ ...usage, credential: "secret-value" });
    expect(update).toEqual({
      checkedAt: "2026-07-18T10:00:00.000Z",
      windows: [
        {
          id: "window",
          kind: "session",
          label: "Session",
          usedPercent: 64,
          windowDurationMins: 300,
          resetsAt: "2026-07-18T14:00:00.000Z",
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 25,
          windowDurationMins: 10080,
          resetsAt: "2026-07-24T10:00:00.000Z",
        },
      ],
    });
    expect(isServerProviderUsageLimits(update)).toBe(true);
    expect(JSON.stringify(update)).not.toContain("private-subscription-label");
    expect(JSON.stringify(update)).not.toContain("secret-value");
  });

  test("clamps valid over-quota percentages", () => {
    const update = museSubscriptionUsageToUpdate({
      ...usage,
      window: { ...usage.window, usedPercent: 120 },
      weekly: { ...usage.weekly, usedPercent: 135 },
    });
    expect(update?.windows.map((window) => window.usedPercent)).toEqual([100, 100]);
  });

  test("keeps stale observations and elapsed resets separate", () => {
    const update = museSubscriptionUsageToUpdate({
      ...usage,
      observedAtMs: Date.parse("2020-01-02T00:00:00Z"),
      window: { ...usage.window, resetsAtMs: Date.parse("2020-01-01T00:00:00Z") },
    });
    expect(update?.checkedAt).toBe("2020-01-02T00:00:00.000Z");
    expect(update?.windows[0]?.resetsAt).toBe("2020-01-01T00:00:00.000Z");
  });

  test.each([
    undefined,
    null,
    {},
    { window: usage.window },
    { ...usage, weekly: undefined },
    { ...usage, observedAtMs: undefined },
    { ...usage, window: { usedPercent: 0 } },
  ])("rejects unknown and incomplete observations: %j", (value) => {
    expect(museSubscriptionUsageToUpdate(value)).toBeUndefined();
  });

  test.each([-1, NaN, Infinity, "50"])("rejects invalid percentages: %j", (value) => {
    expect(
      museSubscriptionUsageToUpdate({
        ...usage,
        window: { ...usage.window, usedPercent: value },
      }),
    ).toBeUndefined();
    expect(
      museSubscriptionUsageToUpdate({
        ...usage,
        weekly: { ...usage.weekly, usedPercent: value },
      }),
    ).toBeUndefined();
  });

  test.each([-1, NaN, Infinity, 8.64e15 + 1, "2026-07-18"])(
    "rejects invalid timestamps: %j",
    (value) => {
      expect(museSubscriptionUsageToUpdate({ ...usage, observedAtMs: value })).toBeUndefined();
      expect(
        museSubscriptionUsageToUpdate({
          ...usage,
          window: { ...usage.window, resetsAtMs: value },
        }),
      ).toBeUndefined();
      expect(
        museSubscriptionUsageToUpdate({
          ...usage,
          weekly: { ...usage.weekly, resetsAtMs: value },
        }),
      ).toBeUndefined();
    },
  );

  test.each([0, -1, NaN, Infinity, 1.5, "300"])("rejects invalid durations: %j", (value) => {
    expect(
      museSubscriptionUsageToUpdate({
        ...usage,
        window: { ...usage.window, windowDurationMins: value },
      }),
    ).toBeUndefined();
  });

  test("accepts actual zero usage without inventing missing values", () => {
    const update = museSubscriptionUsageToUpdate({
      ...usage,
      window: { ...usage.window, usedPercent: 0 },
      weekly: { ...usage.weekly, usedPercent: 0 },
    });
    expect(update?.windows.map((window) => window.usedPercent)).toEqual([0, 0]);
  });
});
