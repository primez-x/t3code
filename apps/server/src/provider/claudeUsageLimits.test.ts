import { describe, expect, test } from "vite-plus/test";

import { claudeRateLimitEventToUpdate, claudeUsageResponseToLimits } from "./claudeUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";
const noNames = { overageIncluded: undefined } as const;

describe("claudeUsageResponseToLimits", () => {
  test.each([false, true])(
    "reports extra usage without inventing a prepaid balance (enabled: %s)",
    (enabled) => {
      const result = claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            extra_usage: {
              is_enabled: enabled,
              monthly_limit: 5000,
              used_credits: 1200,
              utilization: 24,
              currency: "USD",
            },
          },
        },
      }).limits;
      expect(result.extraUsage).toEqual({
        checkedAt,
        enabled,
        available: enabled ? null : false,
        coversModelLimits: true,
        usedPercent: 24,
      });
      expect(result.credits).toBeUndefined();
    },
  );
  test("rejects a spent or zero extra-usage budget", () => {
    for (const extra_usage of [
      { is_enabled: true, monthly_limit: 0, used_credits: 0, utilization: null },
      { is_enabled: true, monthly_limit: 50, used_credits: 50, utilization: 100 },
    ]) {
      expect(
        claudeUsageResponseToLimits({
          checkedAt,
          response: { rate_limits_available: true, rate_limits: { extra_usage } },
        }).limits.extraUsage?.available,
      ).toBe(false);
    }
  });
  test("does not treat an uncapped monthly budget as unlimited credits", () => {
    const result = claudeUsageResponseToLimits({
      checkedAt,
      response: {
        rate_limits_available: true,
        rate_limits: {
          extra_usage: {
            is_enabled: true,
            monthly_limit: null,
            used_credits: null,
            utilization: null,
          },
        },
      },
    }).limits;
    expect(result.extraUsage?.available).toBeNull();
    expect(result.credits).toBeUndefined();
  });

  test("maps the session, weekly, and model-scoped weekly windows", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 54, resets_at: "2026-07-18T14:39:00Z" },
            seven_day: { utilization: 18.4, resets_at: "2026-07-24T08:59:00+00:00" },
            seven_day_opus: { utilization: 3, resets_at: null },
            // Newer CLIs add this on top of the typed keys; the pinned SDK
            // typings do not know it yet.
            ...({
              model_scoped: [
                { display_name: "Fable", utilization: 73, resets_at: "2026-07-24T08:59:00Z" },
                { display_name: "Ghost", utilization: null, resets_at: null },
              ],
            } as object),
            extra_usage: {
              is_enabled: false,
              monthly_limit: null,
              used_credits: null,
              utilization: null,
            },
          },
        },
      }),
    ).toEqual({
      names: { overageIncluded: "Fable" },
      limits: {
        checkedAt,
        extraUsage: { checkedAt, enabled: false, available: false, coversModelLimits: true },
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 54,
            windowDurationMins: 300,
            resetsAt: "2026-07-18T14:39:00.000Z",
          },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 18.4,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
          {
            id: "seven_day_fable",
            modelFamily: "claude-fable",
            kind: "weekly",
            label: "Weekly · Fable",
            usedPercent: 73,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
          {
            id: "seven_day_opus",
            modelFamily: "claude-opus",
            kind: "weekly",
            label: "Weekly · Opus",
            usedPercent: 3,
            windowDurationMins: 10080,
          },
        ],
      },
    });
  });

  test("names the overage-included bucket only from a scoped entry that drew a row", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            ...({
              model_scoped: [
                { display_name: "Ghost", utilization: null, resets_at: null },
                { display_name: "Fable", utilization: 5, resets_at: null },
              ],
            } as object),
          },
        },
      }).names,
    ).toEqual({ overageIncluded: "Fable" });
  });

  test("reports API key and Bedrock accounts as unsupported", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: { rate_limits_available: false, rate_limits: null },
      }).limits,
    ).toEqual({ checkedAt, windows: [], unavailable: { reason: "unsupported" } });
  });

  test("skips a window the endpoint reports without a utilization", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: null, resets_at: null },
            seven_day: { utilization: 250, resets_at: null },
          },
        },
      }).limits.windows,
    ).toEqual([
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
      },
    ]);
  });
});

describe("claudeRateLimitEventToUpdate", () => {
  test.each(["allowed", "allowed_warning"] as const)(
    "publishes provider-confirmed extra usage without a subscription update: %s",
    (overageStatus) => {
      expect(
        claudeRateLimitEventToUpdate({ status: "allowed", overageStatus }, noNames, checkedAt),
      ).toEqual({
        windows: [],
        extraUsage: { checkedAt, enabled: true, available: true, coversModelLimits: true },
      });
    },
  );
  test("publishes denied extra usage and unknown state after a failed status read", () => {
    expect(
      claudeRateLimitEventToUpdate(
        { status: "rejected", overageDisabledReason: "out_of_credits" },
        noNames,
        checkedAt,
      )?.extraUsage?.available,
    ).toBe(false);
    expect(
      claudeRateLimitEventToUpdate(
        { status: "rejected", overageDisabledReason: "fetch_error" },
        noNames,
        checkedAt,
      )?.extraUsage?.available,
    ).toBeNull();
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed",
          overageStatus: "allowed",
          overageDisabledReason: "org_level_disabled",
        },
        noNames,
        checkedAt,
      )?.extraUsage,
    ).toMatchObject({ enabled: false, available: false });
  });

  test("scales the 0–1 utilization and epoch-second reset onto the probe's window id", () => {
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 0.85,
          resetsAt: 1_784_000_000,
        },
        noNames,
        checkedAt,
      ),
    ).toEqual({
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 85,
          windowDurationMins: 10080,
          resetsAt: "2026-07-14T03:33:20.000Z",
        },
      ],
    });
  });

  test("lands the streamed overage-included bucket on the row the probe named", () => {
    const event = {
      status: "allowed",
      rateLimitType: "seven_day_overage_included" as never,
      utilization: 0.4,
    } as const;
    expect(claudeRateLimitEventToUpdate(event, noNames, checkedAt)?.windows[0]).toMatchObject({
      id: "seven_day_overage_included",
      modelFamily: "unrecognized",
      usedPercent: 40,
    });
    expect(claudeRateLimitEventToUpdate(event, { overageIncluded: "Fable" }, checkedAt)).toEqual({
      windows: [
        {
          id: "seven_day_fable",
          modelFamily: "claude-fable",
          kind: "weekly",
          label: "Weekly · Fable",
          usedPercent: 40,
          windowDurationMins: 10080,
        },
      ],
    });
  });

  test("maps legacy scoped events and ignores events without utilization", () => {
    expect(
      claudeRateLimitEventToUpdate(
        { status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.1 },
        noNames,
        checkedAt,
      ),
    ).toMatchObject({
      windows: [{ id: "seven_day_opus", modelFamily: "claude-opus", usedPercent: 10 }],
    });
    expect(
      claudeRateLimitEventToUpdate(
        { status: "rejected", rateLimitType: "five_hour" },
        noNames,
        checkedAt,
      ),
    ).toBeUndefined();
  });
});

describe("Claude quota scopes", () => {
  test("preserves all legacy scoped families beside shared quotas", () => {
    const limits = claudeUsageResponseToLimits({
      checkedAt,
      response: {
        rate_limits_available: true,
        rate_limits: {
          seven_day: { utilization: 10, resets_at: null },
          seven_day_opus: { utilization: 100, resets_at: null },
          seven_day_sonnet: { utilization: 30, resets_at: null },
          ...({
            seven_day_haiku: { utilization: 0, resets_at: null },
            seven_day_fable: { utilization: 120, resets_at: null },
          } as object),
        },
      },
    }).limits;
    expect(
      limits.windows.map(({ id, modelFamily, usedPercent }) => ({ id, modelFamily, usedPercent })),
    ).toEqual([
      { id: "seven_day", modelFamily: undefined, usedPercent: 10 },
      { id: "seven_day_fable", modelFamily: "claude-fable", usedPercent: 100 },
      { id: "seven_day_haiku", modelFamily: "claude-haiku", usedPercent: 0 },
      { id: "seven_day_opus", modelFamily: "claude-opus", usedPercent: 100 },
      { id: "seven_day_sonnet", modelFamily: "claude-sonnet", usedPercent: 30 },
    ]);
  });

  test("keeps unrelated unknown scopes distinct and suppresses private labels", () => {
    const response = {
      rate_limits_available: true,
      rate_limits: {
        model_scoped: [
          { display_name: "secret/customer-one", utilization: 100, resets_at: null },
          { display_name: "secret customer one", utilization: 25, resets_at: null },
          { display_name: "Fable", utilization: 55, resets_at: null },
        ],
      },
    };
    const result = claudeUsageResponseToLimits({ checkedAt, response });
    const unknown = result.limits.windows.filter((window) => window.modelFamily === "unrecognized");
    expect(unknown).toHaveLength(2);
    expect(new Set(unknown.map((window) => window.id)).size).toBe(2);
    expect(unknown.map((window) => window.usedPercent).sort((a, b) => a - b)).toEqual([25, 100]);
    expect(unknown.every((window) => window.label === "Weekly · Unrecognized model")).toBe(true);
    expect(JSON.stringify(result.limits)).not.toContain("secret");
    expect(result.names).toEqual({ overageIncluded: "Fable" });
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed",
          rateLimitType: "seven_day_overage_included",
          utilization: 0.9,
        },
        result.names,
        checkedAt,
      )?.windows[0]?.id,
    ).toBe("seven_day_fable");
    const second = claudeUsageResponseToLimits({
      checkedAt,
      response: {
        ...response,
        rate_limits: { model_scoped: response.rate_limits.model_scoped.toReversed() },
      },
    });
    expect(second.limits).toEqual(result.limits);
  });

  test("ignores a malformed scoped container while retaining shared quotas", () => {
    const { limits } = claudeUsageResponseToLimits({
      checkedAt,
      response: {
        rate_limits_available: true,
        rate_limits: {
          seven_day: { utilization: 100, resets_at: null },
          model_scoped: { display_name: "private", utilization: 100 } as never,
        },
      },
    });
    expect(limits.windows).toEqual([
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
      },
    ]);
  });

  test("retains unknown legacy scopes and streamed scope identities", () => {
    const { limits } = claudeUsageResponseToLimits({
      checkedAt,
      response: {
        rate_limits_available: true,
        rate_limits: {
          ...({ seven_day_private_customer: { utilization: 100, resets_at: null } } as object),
        },
      },
    });
    const update = claudeRateLimitEventToUpdate(
      {
        status: "rejected",
        rateLimitType: "seven_day_private_customer" as never,
        utilization: 1,
      },
      noNames,
      checkedAt,
    );
    expect(limits.windows).toHaveLength(1);
    expect(limits.windows[0]?.modelFamily).toBe("unrecognized");
    expect(update?.windows[0]?.id).toBe(limits.windows[0]?.id);
    expect(JSON.stringify(limits)).not.toContain("private_customer");
  });

  test("keeps an unnamed event separate when multiple Fable buckets exist", () => {
    const { names, limits } = claudeUsageResponseToLimits({
      checkedAt,
      response: {
        rate_limits_available: true,
        rate_limits: {
          model_scoped: [
            { display_name: "Fable 1", utilization: 100, resets_at: null },
            { display_name: "Fable 2", utilization: 20, resets_at: null },
          ],
        },
      },
    });
    expect(names).toEqual(noNames);
    expect(limits.windows.map((window) => window.id)).toEqual([
      "seven_day_fable_1",
      "seven_day_fable_2",
    ]);
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "rejected",
          rateLimitType: "seven_day_overage_included",
          utilization: 1,
        },
        names,
        checkedAt,
      )?.windows[0]?.id,
    ).toBe("seven_day_overage_included");
  });

  test("keeps ambiguous unknown scope events separate from unrelated buckets", () => {
    const { names } = claudeUsageResponseToLimits({
      checkedAt,
      response: {
        rate_limits_available: true,
        rate_limits: {
          model_scoped: [
            { display_name: "private A", utilization: 100, resets_at: null },
            { display_name: "private B", utilization: 20, resets_at: null },
          ],
        },
      },
    });
    expect(names).toEqual(noNames);
  });

  test("does not mistake private names containing a known family for a known scope", () => {
    const { limits } = claudeUsageResponseToLimits({
      checkedAt,
      response: {
        rate_limits_available: true,
        rate_limits: {
          model_scoped: [
            { display_name: "Fable customer-secret", utilization: 100, resets_at: null },
          ],
        },
      },
    });
    expect(limits.windows[0]?.modelFamily).toBe("unrecognized");
    expect(JSON.stringify(limits)).not.toContain("customer-secret");
  });

  test("keeps per-instance event scope names independent", () => {
    const first = claudeUsageResponseToLimits({
      checkedAt,
      response: {
        rate_limits_available: true,
        rate_limits: { model_scoped: [{ display_name: "Fable", utilization: 1, resets_at: null }] },
      },
    });
    const second = claudeUsageResponseToLimits({
      checkedAt,
      response: {
        rate_limits_available: true,
        rate_limits: { model_scoped: [{ display_name: "Opus", utilization: 2, resets_at: null }] },
      },
    });
    const event = {
      status: "allowed",
      rateLimitType: "seven_day_overage_included",
      utilization: 0.5,
    } as const;
    expect(
      claudeRateLimitEventToUpdate(event, first.names, checkedAt)?.windows[0]?.modelFamily,
    ).toBe("claude-fable");
    expect(
      claudeRateLimitEventToUpdate(event, second.names, checkedAt)?.windows[0]?.modelFamily,
    ).toBe("claude-opus");
  });

  test.each([-1, NaN, Infinity])(
    "rejects invalid utilization rather than inventing zero: %j",
    (value) => {
      expect(
        claudeUsageResponseToLimits({
          checkedAt,
          response: {
            rate_limits_available: true,
            rate_limits: {
              seven_day: { utilization: value, resets_at: null },
              model_scoped: [{ display_name: "Fable", utilization: value, resets_at: null }],
            },
          },
        }).limits.windows,
      ).toEqual([]);
      expect(
        claudeRateLimitEventToUpdate(
          {
            status: "allowed",
            rateLimitType: "seven_day",
            utilization: value,
          },
          noNames,
          checkedAt,
        ),
      ).toBeUndefined();
    },
  );
});
