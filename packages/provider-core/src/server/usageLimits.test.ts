import { describe, expect, it, test } from "vite-plus/test";

import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./usageLimits.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

describe("applyUsageLimitsUpdate", () => {
  test("merges paid-usage-only observations without refreshing quota windows", () => {
    const extraUsage = { checkedAt, enabled: true, available: true, coversModelLimits: true };
    const previous = { ...published, extraUsage };
    const timestamp = "2026-09-03T12:00:05.000Z";
    const result = applyUsageLimitsUpdate({
      previous,
      checkedAt: timestamp,
      update: {
        windows: [],
        extraUsage: { ...extraUsage, checkedAt: timestamp, available: false },
      },
    });
    expect(result?.checkedAt).toBe(previous.checkedAt);
    expect(result?.extraUsage?.available).toBe(false);
    expect(
      applyUsageLimitsUpdate({
        previous,
        checkedAt: timestamp,
        update: { windows: [], extraUsage: { ...extraUsage, checkedAt: timestamp } },
      }),
    ).toBe(previous);
    expect(
      applyUsageLimitsUpdate({
        previous,
        checkedAt: timestamp,
        update: { windows: [], extraUsage: null },
      }),
    ).not.toHaveProperty("extraUsage");
    expect(
      applyUsageLimitsUpdate({
        previous,
        checkedAt: timestamp,
        update: { windows: [{ ...session, usedPercent: 45 }] },
      })?.extraUsage,
    ).toEqual(extraUsage);
  });

  test("does not refresh subscription observations with a credit-only change", () => {
    const nextCheckedAt = "2026-09-03T12:10:00.000Z";
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: nextCheckedAt,
      update: {
        windows: [],
        credits: { checkedAt: nextCheckedAt, hasCredits: true, unlimited: false, balance: "30" },
      },
    });
    expect(next?.checkedAt).toBe(checkedAt);
    expect(next?.credits?.checkedAt).toBe(nextCheckedAt);
  });

  test("applies credit-only updates, preserves omitted credits, and clears explicit null", () => {
    const credits = { checkedAt, hasCredits: true, unlimited: false, balance: "20" };
    const previous = { ...published, credits };
    const changed = applyUsageLimitsUpdate({
      previous,
      checkedAt,
      update: { windows: [], credits: { ...credits, balance: "0", hasCredits: false } },
    });
    expect(changed?.credits).toMatchObject({ balance: "0", hasCredits: false });
    expect(changed?.windows).toEqual(published.windows);
    expect(
      applyUsageLimitsUpdate({
        previous,
        checkedAt,
        update: { windows: [{ ...session, usedPercent: 45 }] },
      })?.credits,
    ).toEqual(credits);
    expect(
      applyUsageLimitsUpdate({ previous, checkedAt, update: { windows: [], credits: null } }),
    ).not.toHaveProperty("credits");
    expect(
      applyUsageLimitsUpdate({
        previous,
        checkedAt,
        update: { windows: [], credits: { ...credits, checkedAt: "2026-09-03T12:00:05.000Z" } },
      }),
    ).toBe(previous);
  });

  it("returns the published object itself when no window moved", () => {
    // Codex repeats the same numbers beside every token-usage tick; the
    // ingestion path relies on identity to skip the publish.
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
    });
  });

  test("applies a model-family-only change and keeps unrelated quota data", () => {
    const resetCredits = { availableCount: 2 };
    const previous = { ...published, resetCredits };
    const next = applyUsageLimitsUpdate({
      previous,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...weekly, modelFamily: "claude-opus" }] },
    });
    expect(next).not.toBe(previous);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [session, { ...weekly, modelFamily: "claude-opus" }],
      resetCredits,
    });
  });

  test("clears a prior model scope when the replacement quota is shared", () => {
    const previous = { checkedAt, windows: [{ ...session, modelFamily: "claude-opus" }, weekly] };
    const next = applyUsageLimitsUpdate({
      previous,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 40 }],
      },
    });
    expect(next).not.toBe(previous);
    expect(next).toEqual({ checkedAt: "2026-09-03T12:00:05.000Z", windows: [session, weekly] });
    expect(next?.windows[0]).not.toHaveProperty("modelFamily");
  });

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("preserves reset credits when a streamed window update changes usage", () => {
    const resetCredits = { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, resetCredits },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });

    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
      resetCredits,
    });
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  it("keeps the last good windows through a failed probe but not an unsupported one", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(resolveUsageLimitsAfterProbe({ published, probed: failed })).toBe(published);
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
  });
});
