import { describe, expect, test } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type DelegationModelRoute,
  type DelegationPolicy,
  type ModelSelection,
  type ServerProvider,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { museSubscriptionUsageToUpdate } from "../../../../packages/provider-muse/src/server/usageLimits.ts";
import { selectDelegationTarget } from "./delegationRouting.ts";

const nowMs = Date.parse("2026-10-14T12:00:00Z");
const checkedAt = "2026-10-14T11:59:00Z";
const resetsAt = "2026-10-14T13:00:00Z";
const decodeUsageLimits = Schema.decodeUnknownSync(ServerProviderUsageLimits);
const parent: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex_main"),
  model: "gpt-6-sol",
};
const route = (driver: string, model: string, costPerTask = 1): DelegationModelRoute => ({
  driver: ProviderDriverKind.make(driver),
  model,
  effort: "high",
  costPerTask,
  capabilities: ["coding", "architecture"],
});
const limits = (usedPercent: number, id = "primary"): ServerProviderUsageLimits => ({
  checkedAt,
  windows: [{ id, kind: "weekly", label: "Quota", usedPercent, resetsAt }],
});
const provider = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<string>,
  usageLimits?: ServerProviderUsageLimits,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt,
  models: models.map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: driver === "codex" ? "reasoningEffort" : "effort",
          label: "Effort",
          type: "select",
          options: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, label: id })),
        },
      ],
    },
  })),
  slashCommands: [],
  skills: [],
  ...(usageLimits ? { usageLimits } : {}),
});
const codex = provider("codex_main", "codex", ["gpt-6-sol", "gpt-6-astra"], limits(50));
const claude = provider(
  "claude_main",
  "claudeAgent",
  ["claude-fable-5-1", "claude-sonnet-5"],
  limits(50, "seven_day"),
);
const policy = (
  routes = [
    route("codex", "gpt-6-sol"),
    route("claudeAgent", "claude-fable-5-1"),
    route("codex", "gpt-6-astra"),
  ],
): DelegationPolicy => ({
  version: 1,
  mode: "t3-managed",
  balanceUsage: true,
  preferAlternateProvider: true,
  routes,
});
const select = (overrides: Partial<Parameters<typeof selectDelegationTarget>[0]> = {}) =>
  selectDelegationTarget({
    policy: policy(),
    providers: [codex, claude],
    parent,
    capability: "coding",
    role: "implementation",
    nowMs,
    ...overrides,
    rootModel: overrides.rootModel ?? overrides.parent?.model ?? parent.model,
  });
const selected = (result: ReturnType<typeof select>) => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result;
};

describe("selectDelegationTarget", () => {
  test.each([false, true])(
    "uses an independent fallback after an Opus writer (Astra excluded: %s)",
    (excludeAstra) => {
      const advisors = provider("claude_main", "claudeAgent", [
        "claude-opus-5-5",
        "claude-fable-5-1",
      ]);
      const result = select({
        role: "review",
        providers: [codex, advisors],
        excludedReviewerModels: ["claude-opus-5-5", ...(excludeAstra ? ["gpt-6-astra"] : [])],
        policy: policy([
          route("codex", "gpt-6-sol"),
          route("claudeAgent", "claude-opus-5-5"),
          route("claudeAgent", "claude-fable-5-1"),
          route("codex", "gpt-6-astra"),
        ]),
      });
      if (excludeAstra) expect(result.ok).toBe(false);
      else {
        expect(selected(result).modelSelection.model).toBe("gpt-6-astra");
        expect(selected(result).decision.reason).toBe("advisor-fallback");
        expect(selected(result).modelSelection.options).toContainEqual({
          id: "reasoningEffort",
          value: "high",
        });
      }
    },
  );
  test.each([
    ["gpt-6.1-sol", "claude-opus-5-5", "advisor-opus"],
    ["claude-opus-5-5", "claude-fable-5-1", "advisor-fable"],
    ["muse-wonder-full-1.0", "claude-opus-5-5", "advisor-opus"],
  ])("selects the advisor for root %s", (rootModel, expected, reason) => {
    const advisors = provider("claude_main", "claudeAgent", [
      "claude-fable-5-1",
      "claude-opus-5-5",
    ]);
    const result = selected(
      select({
        role: "advice",
        parent: { ...parent, model: rootModel },
        providers: [codex, advisors],
        policy: policy([
          route("claudeAgent", "claude-fable-5-1", 0.01),
          route("claudeAgent", "claude-opus-5-5", 10),
        ]),
      }),
    );
    expect(result.modelSelection.model).toBe(expected);
    expect(result.modelSelection.options).toContainEqual({ id: "effort", value: "high" });
    expect(result.decision.reason).toBe(reason);
  });
  test.each([
    ["seven_day_fable", "claude-opus-5-5"],
    ["seven_day_opus", "gpt-6-astra"],
  ])("uses the Sol advisor quota rather than %s", (scope, expected) => {
    const advisors = provider(
      "claude_main",
      "claudeAgent",
      ["claude-fable-5-1", "claude-opus-5-5"],
      limits(100, scope),
    );
    const result = selected(
      select({
        role: "advice",
        providers: [codex, advisors],
        policy: policy([
          route("claudeAgent", "claude-fable-5-1"),
          route("claudeAgent", "claude-opus-5-5"),
          route("codex", "gpt-6-astra"),
        ]),
      }),
    );
    expect(result.modelSelection.model).toBe(expected);
  });
  test("preserves the root advisor through a different child model", () => {
    const advisors = provider("claude_main", "claudeAgent", [
      "claude-fable-5-1",
      "claude-opus-5-5",
    ]);
    const result = selected(
      select({
        role: "advice",
        rootModel: "claude-opus-5-5",
        providers: [codex, advisors],
        policy: policy([
          route("claudeAgent", "claude-fable-5-1"),
          route("claudeAgent", "claude-opus-5-5"),
        ]),
      }),
    );
    expect(result.modelSelection.model).toBe("claude-fable-5-1");
  });
  test("defaults pinned advice to high even when a cheaper low route exists", () => {
    const opus = provider("claude_main", "claudeAgent", ["claude-opus-5-5"]);
    const result = selected(
      select({
        role: "advice",
        providers: [codex, opus],
        requestedTarget: { instanceId: opus.instanceId, model: "claude-opus-5-5" },
        policy: policy([
          { ...route("claudeAgent", "claude-opus-5-5", 0.01), effort: "low" },
          route("claudeAgent", "claude-opus-5-5", 2),
        ]),
      }),
    );
    expect(result.modelSelection.options).toContainEqual({ id: "effort", value: "high" });
  });
  test("honors mapped xhigh on a pinned review", () => {
    const opus = provider("claude_main", "claudeAgent", ["claude-opus-5-5"]);
    const result = selected(
      select({
        role: "review",
        providers: [codex, opus],
        requestedTarget: {
          instanceId: opus.instanceId,
          model: "claude-opus-5-5",
          options: [{ id: "effort", value: "xhigh" }],
        },
        policy: policy([{ ...route("claudeAgent", "claude-opus-5-5"), effort: "xhigh" }]),
      }),
    );
    expect(result.modelSelection.options).toContainEqual({ id: "effort", value: "xhigh" });
  });
  test("limits a provider-only review to the requested driver without pinning the parent model", () => {
    const result = selected(
      select({
        role: "review",
        requestedTarget: { driver: ProviderDriverKind.make("codex") },
        providers: [
          { ...codex, models: [...codex.models, { ...codex.models[0]!, slug: "gpt-6.1-sol" }] },
          claude,
        ],
        policy: policy([
          route("codex", "gpt-6-sol"),
          route("codex", "gpt-6.1-sol"),
          route("claudeAgent", "claude-fable-5-1"),
          route("codex", "gpt-6-astra"),
        ]),
      }),
    );
    expect(result.modelSelection.model).toBe("gpt-6.1-sol");
  });
  test("names the Astra fallback rule when Claude is healthy", () => {
    const result = select({
      role: "advice",
      requestedTarget: { instanceId: codex.instanceId, model: "gpt-6-astra" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toContain(
        "Astra requires an unavailable, exhausted, or excluded Claude advisor",
      );
  });
  test.each(["disabled", "exhausted"])(
    "substitutes an unavailable requested Opus review when %s and explains the switch",
    (state) => {
      const opus = provider(
        "claude_main",
        "claudeAgent",
        ["claude-fable-5-1", "claude-opus-5-5"],
        limits(state === "exhausted" ? 100 : 50),
      );
      const result = selected(
        select({
          role: "review",
          providers: [codex, { ...opus, enabled: state !== "disabled" }],
          requestedTarget: {
            instanceId: opus.instanceId,
            model: "claude-opus-5-5",
            options: [{ id: "effort", value: "high" }],
          },
          policy: policy([
            route("claudeAgent", "claude-fable-5-1"),
            route("claudeAgent", "claude-opus-5-5"),
            route("codex", "gpt-6-astra"),
          ]),
        }),
      );
      expect(result.modelSelection.model).toBe("gpt-6-astra");
      expect(result.decision.substitution).toMatchObject({
        requestedModel: "claude-opus-5-5",
        requestedProviderInstanceId: opus.instanceId,
        reason: expect.stringContaining(state === "exhausted" ? "usage" : "unavailable"),
      });
    },
  );
  test("does not substitute for low headroom while the requested model can run", () => {
    const result = selected(
      select({
        requestedTarget: { instanceId: claude.instanceId, model: "claude-fable-5-1" },
        providers: [codex, { ...claude, usageLimits: limits(99) }],
      }),
    );
    expect(result.modelSelection.model).toBe("claude-fable-5-1");
    expect(result.decision.substitution).toBeUndefined();
  });
  test("fails when no capable substitute exists", () => {
    const result = select({
      role: "review",
      providers: [codex, { ...claude, usageLimits: limits(100) }],
      requestedTarget: { instanceId: claude.instanceId, model: "claude-fable-5-1" },
      policy: policy([route("claudeAgent", "claude-fable-5-1")]),
    });
    expect(result.ok).toBe(false);
  });
  test("model-only requests substitute when the provider advertising that model is unavailable", () => {
    const opus = provider("claude_main", "claudeAgent", ["claude-opus-5-5", "claude-fable-5-1"]);
    const result = selected(
      select({
        role: "review",
        providers: [codex, { ...opus, installed: false }],
        requestedTarget: { model: "claude-opus-5-5" },
        policy: policy([route("claudeAgent", "claude-opus-5-5"), route("codex", "gpt-6-astra")]),
      }),
    );
    expect(result.modelSelection.model).toBe("gpt-6-astra");
    expect(result.decision.substitution?.reason).toContain("unavailable");
  });
  test.each(["unmapped", "hidden", "excluded", "unknown"])(
    "exhaustion does not bypass a %s requested-model restriction",
    (state) => {
      const opus = provider("claude_main", "claudeAgent", ["claude-opus-5-5", "claude-fable-5-1"], {
        ...limits(0),
        windows: [{ ...limits(100).windows[0]!, id: "seven_day_opus" }],
      });
      const result = select({
        role: "review",
        providers: [codex, state === "unknown" ? { ...opus, installed: false } : opus],
        requestedTarget: {
          instanceId: opus.instanceId,
          model: state === "unknown" ? "unknown-opus" : "claude-opus-5-5",
        },
        excludedReviewerModels: state === "excluded" ? ["claude-opus-5-5"] : [],
        hiddenModelsByInstance: state === "hidden" ? { claude_main: ["claude-opus-5-5"] } : {},
        policy: policy([
          route("claudeAgent", "claude-fable-5-1"),
          route("codex", "gpt-6-astra"),
          ...(state === "unmapped" ? [] : [route("claudeAgent", "claude-opus-5-5")]),
        ]),
      });
      expect(result.ok).toBe(false);
    },
  );
  // Pin failure cases: missing, disabled, exhausted, hidden, excluded, or unmapped targets.
  test.each(["advice", "review", "general"] as const)(
    "preserves explicit Opus for %s across separate requests",
    (role) => {
      const opus = provider(
        "claude_main",
        "claudeAgent",
        ["claude-fable-5-1", "claude-opus-5-5"],
        limits(84),
      );
      const input = {
        role,
        capability: "architecture" as const,
        providers: [codex, opus],
        requestedTarget: { instanceId: opus.instanceId, model: "claude-opus-5-5" },
        policy: policy([
          route("claudeAgent", "claude-fable-5-1", 0.1),
          route("claudeAgent", "claude-opus-5-5", 2),
          route("codex", "gpt-6-astra", 0.01),
        ]),
      };
      for (let round = 0; round < 2; round++) {
        const result = selected(select(input));
        expect(result.modelSelection.model).toBe("claude-opus-5-5");
        expect(result.modelSelection.options).toContainEqual({ id: "effort", value: "high" });
        expect(result.decision.reason).toBe("explicit-target");
      }
    },
  );
  test.each(["missing", "hidden", "excluded", "unmapped"])(
    "refuses an explicit Opus review without substitution when %s",
    (state) => {
      const opus = provider(
        "claude_main",
        "claudeAgent",
        ["claude-fable-5-1", "claude-opus-5-5"],
        limits(state === "exhausted" ? 100 : 50),
      );
      const result = select({
        role: "review",
        providers: [codex, { ...opus, enabled: state !== "disabled" }],
        requestedTarget: {
          instanceId: opus.instanceId,
          model: state === "missing" ? "missing-opus" : "claude-opus-5-5",
        },
        excludedReviewerModels: state === "excluded" ? ["claude-opus-5-5"] : [],
        hiddenModelsByInstance: state === "hidden" ? { claude_main: ["claude-opus-5-5"] } : {},
        policy: policy([
          route("claudeAgent", "claude-fable-5-1"),
          route("codex", "gpt-6-astra"),
          ...(state === "unmapped" ? [] : [route("claudeAgent", "claude-opus-5-5")]),
        ]),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain(
          state === "missing" ? "missing-opus" : "claude-opus-5-5",
        );
        expect(result.error.message).toContain("No substitute");
      }
    },
  );

  test("prefers alternate providers within five quota percentage points", () => {
    expect(selected(select()).modelSelection.instanceId).toBe("claude_main");
  });
  test("favors materially greater comparable headroom", () => {
    expect(
      selected(select({ providers: [codex, { ...claude, usageLimits: limits(70, "seven_day") }] }))
        .modelSelection.instanceId,
    ).toBe("codex_main");
  });
  test.each([
    undefined,
    { ...limits(10), checkedAt: "2026-10-14T11:54:59Z" },
    { ...limits(10), unavailable: { reason: "probeFailed" as const } },
  ])("prefers verified headroom over unknown alternate usage (%#)", (usageLimits) => {
    const result = selected(select({ providers: [codex, { ...claude, usageLimits }] }));
    expect(result.modelSelection.instanceId).toBe("codex_main");
    expect(result.decision.headroomPercent).toBe(50);
    expect(result.decision.reason).toBe("headroom");
  });
  test("uses an alternate provider when all headroom is unknown", () => {
    const result = selected(
      select({
        providers: [
          { ...codex, usageLimits: undefined },
          { ...claude, usageLimits: undefined },
        ],
      }),
    );
    expect(result.modelSelection.instanceId).toBe("claude_main");
    expect(result.decision.headroomPercent).toBeNull();
  });
  test("keeps unknown usage eligible when balance is disabled", () => {
    const result = selected(
      select({
        policy: { ...policy(), balanceUsage: false },
        providers: [codex, { ...claude, usageLimits: undefined }],
      }),
    );
    expect(result.modelSelection.instanceId).toBe("claude_main");
  });
  test("uses unknown usage when verified providers are exhausted", () => {
    const result = selected(
      select({
        providers: [
          { ...codex, usageLimits: limits(100) },
          { ...claude, usageLimits: undefined },
        ],
      }),
    );
    expect(result.modelSelection.instanceId).toBe("claude_main");
    expect(result.decision.headroomPercent).toBeNull();
  });
  test("chooses the cheaper parent model when model diversity is disabled", () => {
    expect(
      selected(
        select({
          policy: {
            ...policy([route("codex", "gpt-6-sol", 0.1), route("codex", "gpt-6-astra", 10)]),
            preferAlternateProvider: false,
          },
          providers: [codex],
        }),
      ).modelSelection.model,
    ).toBe("gpt-6-sol");
  });
  test("uses lowest cost before route order or active account count", () => {
    const models = ["gpt-6-luna", "gpt-6-astra"];
    const worker = provider("codex_workers", "codex", models);
    expect(
      selected(
        select({
          policy: {
            ...policy([route("codex", "gpt-6-astra", 10), route("codex", "gpt-6-luna", 0.2)]),
            preferAlternateProvider: false,
          },
          providers: [worker],
          activeAssignments: [{ instanceId: worker.instanceId, model: models[0]! }],
        }),
      ).modelSelection.model,
    ).toBe("gpt-6-luna");
  });
  test("never selects known exhausted quota even when balance is disabled", () => {
    expect(
      selected(
        select({
          policy: { ...policy(), balanceUsage: false },
          providers: [codex, { ...claude, usageLimits: limits(100, "seven_day") }],
        }),
      ).modelSelection.instanceId,
    ).toBe("codex_main");
  });
  test.each([true, false])(
    "rejects Muse exhausted shared session with open weekly quota (balance %s)",
    (balanceUsage) => {
      const usageLimits = decodeUsageLimits(
        museSubscriptionUsageToUpdate({
          observedAtMs: Date.parse(checkedAt),
          window: { usedPercent: 100, windowDurationMins: 300, resetsAtMs: Date.parse(resetsAt) },
          weekly: { usedPercent: 20, resetsAtMs: Date.parse(resetsAt) },
        }),
      );
      const result = select({
        providers: [provider("muse_main", "muse", ["Spark1.3"], usageLimits)],
        policy: { ...policy([route("muse", "Spark1.3")]), balanceUsage },
      });
      expect(result.ok).toBe(false);
    },
  );
  test.each([
    { ...limits(100), checkedAt: "2026-10-14T11:54:59Z" },
    { ...limits(100), checkedAt: "2026-10-14T12:01:00Z" },
    { checkedAt, windows: [] },
    {
      checkedAt,
      windows: [{ id: "seven_day", kind: "weekly" as const, label: "Quota", usedPercent: 100 }],
    },
    { ...limits(100), windows: [{ ...limits(100).windows[0]!, resetsAt: checkedAt }] },
    { ...limits(100), unavailable: { reason: "unsupported" as const } },
    { ...limits(100), unavailable: { reason: "probeFailed" as const } },
  ])("treats stale or incomplete quota as unknown (%#)", (usageLimits) => {
    const result = selected(select({ providers: [{ ...claude, usageLimits }] }));
    expect(result.decision.headroomPercent).toBeNull();
    expect(result.decision.usageCheckedAt).toBeNull();
  });
  test("applies only matching scoped windows and the tightest shared window", () => {
    const usageLimits = {
      checkedAt,
      windows: [
        ...limits(99, "seven_day_opus").windows,
        ...limits(40, "seven_day").windows,
        ...limits(60, "seven_day_fable").windows,
      ],
    };
    expect(
      selected(select({ providers: [{ ...claude, usageLimits }] })).decision.headroomPercent,
    ).toBe(40);
  });
  test("does not interpret unfamiliar model buckets as shared quota", () => {
    expect(
      selected(
        select({
          providers: [
            {
              ...claude,
              usageLimits: {
                ...limits(100, "seven_day_unknown_model"),
                windows: limits(100, "seven_day_unknown_model").windows.map((window) => ({
                  ...window,
                  modelFamily: "unrecognized",
                })),
              },
            },
          ],
        }),
      ).decision.headroomPercent,
    ).toBeNull();
  });
  test("reports unknown headroom when shared quota coexists with unrecognized scope", () => {
    const usageLimits = {
      checkedAt,
      windows: [
        ...limits(31, "seven_day").windows,
        { ...limits(90, "unknown_bucket").windows[0]!, modelFamily: "unrecognized" },
      ],
    };
    const result = selected(select({ providers: [{ ...claude, usageLimits }] }));
    expect(result.decision.headroomPercent).toBeNull();
    expect(result.decision.usageCheckedAt).toBeNull();
  });
  test("still rejects exhausted shared quota beside an unrecognized scope", () => {
    const usageLimits = {
      checkedAt,
      windows: [
        ...limits(100, "seven_day").windows,
        { ...limits(31, "unknown_bucket").windows[0]!, modelFamily: "unrecognized" },
      ],
    };
    expect(select({ providers: [{ ...claude, usageLimits }] }).ok).toBe(false);
  });
  test("honors explicit scope without blocking unrelated models", () => {
    const usageLimits = {
      checkedAt,
      windows: [{ ...limits(100).windows[0]!, modelFamily: "claude-sonnet" }],
    };
    expect(
      selected(select({ providers: [{ ...claude, usageLimits }] })).decision.headroomPercent,
    ).toBeNull();
  });
  test("uses Astra when explicit Fable model scope is exhausted", () => {
    const usageLimits = {
      checkedAt,
      windows: [{ ...limits(100).windows[0]!, modelFamily: "claude-fable-5-1" }],
    };
    expect(
      selected(
        select({
          role: "advice",
          parent: { instanceId: claude.instanceId, model: "claude-opus-5-5" },
          providers: [codex, { ...claude, usageLimits }],
        }),
      ).modelSelection.model,
    ).toBe("gpt-6-astra");
  });
  test("does not use Astra while another Claude account remains available", () => {
    const spare = { ...claude, instanceId: ProviderInstanceId.make("claude_spare") };
    expect(
      selected(
        select({
          role: "advice",
          parent: { instanceId: claude.instanceId, model: "claude-opus-5-5" },
          providers: [codex, { ...claude, usageLimits: limits(100, "seven_day") }, spare],
        }),
      ).modelSelection.instanceId,
    ).toBe("claude_spare");
  });
  test.each([
    { enabled: false },
    { installed: false },
    { status: "error" as const },
    { status: "disabled" as const },
    { availability: "unavailable" as const },
    { auth: { status: "unauthenticated" as const } },
  ])("rejects unhealthy providers (%#)", (change) => {
    expect(select({ providers: [{ ...claude, ...change }] }).ok).toBe(false);
  });
  test("honors providers that cannot run child tasks", () => {
    expect(
      selected(select({ allowedProviderInstanceIds: [codex.instanceId] })).modelSelection
        .instanceId,
    ).toBe("codex_main");
  });
  test("requires declared capability and available model", () => {
    expect(select({ policy: policy([route("claudeAgent", "missing")]) }).ok).toBe(false);
    expect(select({ capability: "lookup" }).ok).toBe(false);
  });
  test("requires permitted effort and overrides inherited Max defaults", () => {
    const result = selected(
      select({
        parent: { ...parent, options: [{ id: "reasoningEffort", value: "max" }] },
        providers: [codex],
      }),
    );
    expect(result.modelSelection.options).toEqual([{ id: "reasoningEffort", value: "high" }]);
    const models = codex.models.map((model) => ({
      ...model,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Effort",
            type: "select" as const,
            options: [{ id: "max", label: "Max", isDefault: true }],
          },
        ],
      },
    }));
    expect(select({ providers: [{ ...codex, models }] }).ok).toBe(false);
  });
  test.each([true, false])(
    "neutralizes native priority only when the default tier is advertised (%s)",
    (advertisesDefault) => {
      const models = codex.models.map((model) => ({
        ...model,
        capabilities: {
          optionDescriptors: [
            ...model.capabilities!.optionDescriptors!,
            {
              id: "serviceTier",
              label: "Service tier",
              type: "select" as const,
              currentValue: "priority",
              options: (advertisesDefault ? ["default", "priority"] : ["priority"]).map((id) => ({
                id,
                label: id,
              })),
            },
          ],
        },
      }));
      const result = selected(select({ providers: [{ ...codex, models }] }));
      expect(result.modelSelection.options).toEqual(
        advertisesDefault
          ? [
              { id: "reasoningEffort", value: "high" },
              { id: "serviceTier", value: "default" },
            ]
          : [{ id: "reasoningEffort", value: "high" }],
      );
    },
  );
  test("neutralizes native fast mode when the catalog advertises a boolean", () => {
    const models = claude.models.map((model) => ({
      ...model,
      capabilities: {
        optionDescriptors: [
          ...model.capabilities!.optionDescriptors!,
          { id: "fastMode", label: "Fast mode", type: "boolean" as const, currentValue: true },
        ],
      },
    }));
    const result = selected(select({ providers: [{ ...claude, models }] }));
    expect(result.modelSelection.options).toEqual([
      { id: "effort", value: "high" },
      { id: "fastMode", value: false },
    ]);
  });
  test("rejects hidden Max defaults on a second effort descriptor", () => {
    const models = codex.models.map((model) => ({
      ...model,
      capabilities: {
        optionDescriptors: [
          ...model.capabilities!.optionDescriptors!,
          {
            id: "effort",
            label: "Effort",
            type: "select" as const,
            options: [{ id: "ultra", label: "Ultra", isDefault: true }],
          },
        ],
      },
    }));
    expect(select({ providers: [{ ...codex, models }] }).ok).toBe(false);
  });
  test("does not infer capability from unrelated custom model names", () => {
    expect(
      select({ providers: [provider("custom", "claudeAgent", ["my-claude-fable-proxy"])] }).ok,
    ).toBe(false);
  });
  test("skips hidden built-in Haiku for automatic selection", () => {
    const workers = provider("claude_main", "claudeAgent", ["claude-haiku-5-5", "claude-sonnet-5"]);
    const result = selected(
      select({
        providers: [workers],
        policy: policy([
          route("claudeAgent", "claude-haiku-5-5", 0.1),
          route("claudeAgent", "claude-sonnet-5", 1),
        ]),
        hiddenModelsByInstance: { claude_main: ["claude-haiku-5-5"] },
      }),
    );
    expect(result.modelSelection.model).toBe("claude-sonnet-5");
  });
  test("keeps a hidden model slug eligible on another provider instance", () => {
    const workers = provider("claude_main", "claudeAgent", ["claude-haiku-5-5"]);
    const spare = { ...workers, instanceId: ProviderInstanceId.make("claude_spare") };
    const result = selected(
      select({
        providers: [workers, spare],
        policy: policy([route("claudeAgent", "claude-haiku-5-5")]),
        hiddenModelsByInstance: { claude_main: ["claude-haiku-5-5"] },
      }),
    );
    expect(result.modelSelection.instanceId).toBe("claude_spare");
  });
  test("keeps custom models eligible when their slug appears in hidden models", () => {
    const workers = provider("claude_main", "claudeAgent", ["claude-haiku-5-5"]);
    const result = selected(
      select({
        providers: [
          { ...workers, models: workers.models.map((model) => ({ ...model, isCustom: true })) },
        ],
        policy: policy([route("claudeAgent", "claude-haiku-5-5")]),
        hiddenModelsByInstance: { claude_main: ["claude-haiku-5-5"] },
      }),
    );
    expect(result.modelSelection.model).toBe("claude-haiku-5-5");
  });
  test("hidden Fable still prevents Astra advice fallback on healthy Claude", () => {
    const result = select({
      role: "advice",
      hiddenModelsByInstance: { claude_main: ["claude-fable-5-1"] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("advisor-unavailable");
  });
  test("hidden Fable writer still permits a distinct architecture reviewer", () => {
    const result = selected(
      select({
        role: "review",
        capability: "architecture",
        parent: { instanceId: claude.instanceId, model: "claude-opus-5-5" },
        excludedReviewerModels: ["claude-fable-5-1"],
        hiddenModelsByInstance: { claude_main: ["claude-fable-5-1"] },
      }),
    );
    expect(result.modelSelection.model).toBe("gpt-6-sol");
  });
  test.each([
    {
      role: "implementation" as const,
      family: "claude-haiku",
      older: "claude-haiku-4-5",
      current: "claude-haiku-5-5",
    },
    {
      role: "advice" as const,
      family: "claude-fable",
      older: "claude-fable-5",
      current: "claude-fable-5-1",
    },
  ])(
    "excludes legacy catalog models from $family family routes for $role",
    ({ role, family, older, current }) => {
      const workers = provider("claude_main", "claudeAgent", [older, current]);
      const models = workers.models.map((model) => ({ ...model, isLegacy: model.slug === older }));
      expect(
        selected(
          select({
            role,
            parent: { instanceId: claude.instanceId, model: "claude-opus-5-5" },
            providers: [{ ...workers, models }],
            policy: policy([route("claudeAgent", `${family}-*`)]),
          }),
        ).modelSelection.model,
      ).toBe(current);
    },
  );
  test("permits an exact configured legacy model route", () => {
    const workers = provider("claude_main", "claudeAgent", ["claude-haiku-4-5"]);
    const models = workers.models.map((model) => ({ ...model, isLegacy: true }));
    expect(
      selected(
        select({
          providers: [{ ...workers, models }],
          policy: policy([route("claudeAgent", "claude-haiku-4-5", 0.1)]),
        }),
      ).modelSelection.model,
    ).toBe("claude-haiku-4-5");
  });
  test("matches explicit catalog aliases and family wildcards", () => {
    const models = claude.models.map((model) => ({ ...model, aliases: ["fable"] }));
    expect(
      selected(
        select({
          policy: policy([route("claudeAgent", "fable")]),
          providers: [{ ...claude, models }],
        }),
      ).modelSelection.model,
    ).toBe("claude-fable-5-1");
    expect(
      selected(select({ policy: policy([route("claudeAgent", "claude-fable-*")]) })).modelSelection
        .model,
    ).toBe("claude-fable-5-1");
  });
  test.each([
    { driver: "codex", base: "gpt-6.1-sol", suffix: "gpt-6.1-sol-codex" },
    { driver: "muse", base: "Spark1.3", suffix: "Spark1.3-contributor" },
  ])(
    "matches the base and suffix models in an explicit $base family",
    ({ driver, base, suffix }) => {
      const familyPolicy = policy([route(driver, `${base}-*`)]);
      expect(
        selected(select({ policy: familyPolicy, providers: [provider("family", driver, [base])] }))
          .modelSelection.model,
      ).toBe(base);
      expect(
        selected(
          select({ policy: familyPolicy, providers: [provider("family", driver, [suffix])] }),
        ).modelSelection.model,
      ).toBe(suffix);
      expect(
        select({
          policy: familyPolicy,
          providers: [provider("family", driver, [`my-${base}`, `${base}proxy`])],
        }).ok,
      ).toBe(false);
      expect(
        select({
          policy: policy([route(driver, `${base}*`)]),
          providers: [provider("family", driver, [base, suffix])],
        }).ok,
      ).toBe(false);
    },
  );
  test("uses fewer active assignments for otherwise equal account instances", () => {
    const spare = { ...claude, instanceId: ProviderInstanceId.make("claude_spare") };
    expect(
      selected(
        select({
          providers: [claude, spare],
          activeAssignments: [{ instanceId: claude.instanceId, model: "claude-fable-5-1" }],
        }),
      ).modelSelection.instanceId,
    ).toBe("claude_spare");
  });
  test("keeps quota isolated between account instances", () => {
    const spare = {
      ...claude,
      instanceId: ProviderInstanceId.make("claude_spare"),
      usageLimits: limits(100, "seven_day"),
    };
    expect(selected(select({ providers: [spare, claude] })).modelSelection.instanceId).toBe(
      "claude_main",
    );
  });
  test("produces the same choice regardless of provider order", () => {
    const spare = { ...claude, instanceId: ProviderInstanceId.make("claude_spare") };
    expect(selected(select({ providers: [spare, claude] })).modelSelection).toEqual(
      selected(select({ providers: [claude, spare] })).modelSelection,
    );
  });
  test.each(["advice", "review"] as const)(
    "prefers Fable high for Opus-root %s despite quota and cost",
    (role) => {
      const result = selected(
        select({
          role,
          capability: "architecture",
          parent: { instanceId: claude.instanceId, model: "claude-opus-5-5" },
          providers: [codex, { ...claude, usageLimits: limits(99, "seven_day") }],
        }),
      );
      expect(result.modelSelection.model).toBe("claude-fable-5-1");
      expect(result.modelSelection.options).toEqual([{ id: "effort", value: "high" }]);
    },
  );
  test.each(["advice", "review"] as const)(
    "uses and records architecture for explicit lower-capability %s",
    (role) => {
      const result = selected(
        select({
          role,
          capability: "lookup",
          requestedTarget: { instanceId: claude.instanceId, model: "claude-fable-5-1" },
          policy: policy([
            { ...route("claudeAgent", "claude-fable-5-1"), capabilities: ["architecture"] },
          ]),
        }),
      );
      expect(result.modelSelection.model).toBe("claude-fable-5-1");
      expect(result.modelSelection.options).toEqual([{ id: "effort", value: "high" }]);
      expect(result.decision.capability).toBe("architecture");
    },
  );
  test("preserves configured XHigh effort for an explicit distinct reviewer", () => {
    const result = selected(
      select({
        role: "review",
        capability: "architecture",
        parent: { instanceId: claude.instanceId, model: "claude-fable-5-1" },
        requestedTarget: {
          instanceId: codex.instanceId,
          model: "gpt-6-sol",
          options: [{ id: "reasoningEffort", value: "xhigh" }],
        },
        policy: policy([{ ...route("codex", "gpt-6-sol", 10), effort: "xhigh" }]),
      }),
    );
    expect(result.modelSelection.options).toEqual([{ id: "reasoningEffort", value: "xhigh" }]);
  });
  test("chooses the cheaper configured High route for automatic distinct review", () => {
    const result = selected(
      select({
        role: "review",
        capability: "architecture",
        parent: { instanceId: claude.instanceId, model: "claude-opus-5-5" },
        excludedReviewerModels: ["claude-fable-5-1"],
        policy: policy([
          { ...route("codex", "gpt-6-sol", 10), effort: "xhigh" },
          route("codex", "gpt-6-sol", 1),
        ]),
      }),
    );
    expect(result.modelSelection.options).toEqual([{ id: "reasoningEffort", value: "high" }]);
  });
  test.each(["Fable", "Astra"] as const)(
    "rejects a configured Low route for the fixed %s advisor",
    (advisor) => {
      const driver = advisor === "Fable" ? "claudeAgent" : "codex";
      const model = advisor === "Fable" ? "claude-fable-5-1" : "gpt-6-astra";
      const result = select({
        role: "advice",
        parent: { instanceId: claude.instanceId, model: "claude-opus-5-5" },
        capability: "architecture",
        providers: advisor === "Fable" ? [codex, claude] : [codex, { ...claude, enabled: false }],
        policy: policy([{ ...route(driver, model, 0.1), effort: "low" }]),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.category).toBe("no-candidate");
    },
  );
  test("reports effective advice floor and route limits when the policy has no architecture route", () => {
    const result = select({
      role: "advice",
      parent: { instanceId: claude.instanceId, model: "claude-opus-5-5" },
      capability: "lookup",
      policy: policy([{ ...route("claudeAgent", "claude-fable-5-1"), capabilities: ["lookup"] }]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("no-candidate");
      expect(result.error.capability).toBe("architecture");
      expect(result.error.message).toContain("architecture");
      expect(result.error.message).toContain("advice");
      expect(result.error.message).toContain("configured route");
    }
  });
  test("uses Astra high only when all Claude accounts are unavailable or exhausted", () => {
    expect(
      selected(
        select({
          role: "advice",
          parent: { instanceId: claude.instanceId, model: "claude-opus-5-5" },
          providers: [codex, { ...claude, usageLimits: limits(100, "seven_day_fable") }],
        }),
      ).modelSelection.model,
    ).toBe("gpt-6-astra");
    expect(
      selected(select({ role: "advice", providers: [codex, { ...claude, enabled: false }] }))
        .modelSelection.model,
    ).toBe("gpt-6-astra");
  });
  test("fails when the preferred advisor is absent while Claude remains available", () => {
    const result = select({
      role: "advice",
      providers: [codex, provider("claude_main", "claudeAgent", ["claude-sonnet-5"])],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("advisor-unavailable");
  });
  test("does not allow cheap worker routes to displace the advisor rule", () => {
    expect(select({ role: "advice", policy: policy([route("codex", "gpt-6-sol")]) }).ok).toBe(
      false,
    );
  });
  test("excludes the root and writer models from independent review", () => {
    const result = select({ role: "review", excludedReviewerModels: ["claude-fable-5-1"] });
    expect(result.ok).toBe(false);
    expect(
      selected(
        select({
          role: "review",
          parent: { instanceId: claude.instanceId, model: "claude-opus-5-5" },
          excludedReviewerModels: ["claude-fable-5-1"],
        }),
      ).modelSelection.model,
    ).toBe("gpt-6-sol");
  });
  test("selects Opus when Fable was a writer and Sol is the root", () => {
    const reviewers = {
      ...claude,
      models: [...claude.models, ...provider("unused", "claudeAgent", ["claude-opus-5-5"]).models],
    };
    const result = selected(
      select({
        role: "review",
        excludedReviewerModels: ["claude-fable-5-1"],
        providers: [codex, reviewers],
        policy: policy([
          route("claudeAgent", "claude-fable-5-1"),
          route("claudeAgent", "claude-opus-5-5"),
          route("codex", "gpt-6-sol"),
          route("codex", "gpt-6-astra"),
        ]),
      }),
    );
    expect(result.modelSelection.model).toBe("claude-opus-5-5");
  });
  test.each(["root", "writer"] as const)(
    "allows explicit Sol review after global Fable %s exclusion",
    (source) => {
      const reviewers = {
        ...claude,
        models: [
          ...claude.models,
          ...provider("unused", "claudeAgent", ["claude-opus-5-5"]).models,
        ],
      };
      const result = selected(
        select({
          role: "review",
          capability: "architecture",
          parent: {
            instanceId: claude.instanceId,
            model: source === "root" ? "claude-fable-5-1" : "claude-opus-5-5",
          },
          excludedReviewerModels: source === "writer" ? ["claude-fable-5-1"] : [],
          providers: [{ ...codex, usageLimits: limits(90) }, reviewers],
          requestedTarget: { instanceId: codex.instanceId, model: "gpt-6-sol" },
          policy: policy([
            route("claudeAgent", "claude-fable-5-1"),
            route("claudeAgent", "claude-opus-5-5"),
            route("codex", "gpt-6-sol"),
            route("codex", "gpt-6-astra"),
          ]),
        }),
      );
      expect(result.modelSelection.model).toBe("gpt-6-sol");
      expect(result.modelSelection.instanceId).toBe("codex_main");
    },
  );
  test.each(["advice", "review"] as const)(
    "denies explicit Astra %s while global Claude remains healthy",
    (role) => {
      expect(
        select({ role, requestedTarget: { instanceId: codex.instanceId, model: "gpt-6-astra" } })
          .ok,
      ).toBe(false);
    },
  );
  test("denies explicit Astra review after global Fable root exclusion", () => {
    expect(
      select({
        role: "review",
        parent: { instanceId: claude.instanceId, model: "claude-fable-5-1" },
        requestedTarget: { instanceId: codex.instanceId, model: "gpt-6-astra" },
      }).ok,
    ).toBe(false);
  });
  test("matches an explicit target catalog alias on the requested instance", () => {
    const models = codex.models.map((model) => ({
      ...model,
      aliases: model.slug === "gpt-6-sol" ? ["sol"] : [],
    }));
    const result = selected(
      select({
        providers: [{ ...codex, models }, claude],
        requestedTarget: { instanceId: codex.instanceId, model: "sol" },
      }),
    );
    expect(result.modelSelection.model).toBe("gpt-6-sol");
    expect(result.modelSelection.instanceId).toBe("codex_main");
  });
  test("rejects an explicit target from an unknown provider instance", () => {
    expect(
      select({
        requestedTarget: { instanceId: ProviderInstanceId.make("missing"), model: "gpt-6-sol" },
      }).ok,
    ).toBe(false);
  });
  test("rejects Astra as an alternative reviewer while Claude remains available", () => {
    const result = select({
      role: "review",
      parent: { instanceId: claude.instanceId, model: "claude-fable-5-1" },
      policy: policy([route("claudeAgent", "claude-fable-5-1"), route("codex", "gpt-6-astra")]),
    });
    expect(result.ok).toBe(false);
  });
  test("requires architecture capability for an alternative reviewer", () => {
    const result = select({
      role: "review",
      parent: { instanceId: claude.instanceId, model: "claude-fable-5-1" },
      policy: policy([
        route("claudeAgent", "claude-fable-5-1"),
        { ...route("codex", "gpt-6-sol"), capabilities: ["coding"] },
      ]),
    });
    expect(result.ok).toBe(false);
  });
  test("selects Opus review without requiring Fable for a Sol root", () => {
    const result = select({
      role: "review",
      providers: [codex, provider("claude_main", "claudeAgent", ["claude-opus-5-5"])],
      policy: policy([route("claudeAgent", "claude-opus-5-5"), route("codex", "gpt-6-astra")]),
    });
    expect(selected(result).modelSelection.model).toBe("claude-opus-5-5");
  });
  test("returns bounded decisions without account details", () => {
    const result = selected(
      select({
        providers: [
          { ...codex, enabled: false },
          {
            ...claude,
            auth: { status: "authenticated", email: "private@example.com" },
            usageLimits: { ...limits(25, "seven_day"), credentialFingerprint: "secret-reference" },
          },
        ],
      }),
    );
    expect(result.decision).toEqual({
      policyVersion: 1,
      capability: "coding",
      role: "implementation",
      reason: "alternate-provider",
      headroomPercent: 75,
      usageCheckedAt: checkedAt,
    });
  });
});
