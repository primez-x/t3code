import { expect, test } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { selectDelegationTarget } from "./delegationRouting.ts";
import { resolveDelegationPolicy } from "./combinedDelegationRoutes.ts";

test("the combined preset contains only supplied costs and bounded Muse routes", () => {
  const policy = resolveDelegationPolicy({
    ...DEFAULT_SERVER_SETTINGS.delegationPolicy,
    version: 1,
    mode: "t3-managed",
    allowCredits: false,
    routingPriority: "usage",
    preferAlternateProvider: true,
    routes: [],
  });
  expect(policy.routes).toHaveLength(22);
  expect(
    policy.routes.every((route) => ["low", "medium", "high", "xhigh"].includes(route.effort)),
  ).toBe(true);
  expect(policy.routes.find((route) => route.driver === "muse")).toMatchObject({
    model: "muse-spark-1.3-*",
    effort: "xhigh",
    costPerTask: 0.684,
  });
  expect(policy.routes.find((route) => route.driver === "muse")?.capabilities).not.toContain(
    "architecture",
  );
  expect(
    policy.routes
      .filter((route) => route.capabilities.includes("architecture"))
      .every((route) => /opus|sol|fable|astra/.test(route.model)),
  ).toBe(true);
});

test("configured routes replace the built-in preset", () => {
  const routes = [
    {
      driver: ProviderDriverKind.make("codex"),
      model: "custom",
      effort: "high",
      capabilities: ["coding"],
      costPerTask: 3,
    },
  ] as const;
  expect(
    resolveDelegationPolicy({
      ...DEFAULT_SERVER_SETTINGS.delegationPolicy,
      version: 1,
      mode: "native-preferred",
      allowCredits: false,
      routingPriority: "cost",
      preferAlternateProvider: false,
      routes,
    }).routes,
  ).toBe(routes);
});

test("the default Codex exact lookup floor uses Luna medium", () => {
  const instanceId = ProviderInstanceId.make("codex_lookup");
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "1970-01-01T00:00:00Z",
    models: [
      {
        slug: "gpt-6-luna",
        name: "Luna",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Effort",
              type: "select",
              options: ["low", "medium", "high", "xhigh"].map((id) => ({ id, label: id })),
            },
          ],
        },
      },
    ],
    slashCommands: [],
    skills: [],
  };
  const policy = resolveDelegationPolicy({
    ...DEFAULT_SERVER_SETTINGS.delegationPolicy,
    version: 1,
    mode: "t3-managed",
    allowCredits: false,
    routingPriority: "usage",
    preferAlternateProvider: true,
    routes: [],
  });
  const result = selectDelegationTarget({
    policy,
    providers: [provider],
    parent: { instanceId, model: "gpt-6.1-sol" },
    rootModel: "gpt-6.1-sol",
    role: "research",
    capability: "lookup",
    nowMs: 0,
  });
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(result.modelSelection).toEqual({
      instanceId,
      model: "gpt-6-luna",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
  expect(
    policy.routes.some((route) => route.model === "gpt-6-luna-*" && route.effort === "low"),
  ).toBe(false);
});
