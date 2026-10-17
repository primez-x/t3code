import {
  type DelegationPolicy,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";

export function makeDelegationFixtures(
  models: ReadonlyArray<ModelSelection & { readonly driver: ProviderDriverKind }>,
) {
  const policy: DelegationPolicy = {
    version: 1,
    mode: "native-preferred",
    allowCredits: false,
    balanceUsage: false,
    preferAlternateProvider: false,
    routes: models.map(({ driver, model }) => ({
      driver,
      model,
      effort: "medium",
      capabilities: [
        "lookup",
        "discovery",
        "mechanical",
        "routine",
        "coding",
        "substantial",
        "architecture",
      ],
      costPerTask: 0,
    })),
  };
  const providers: ReadonlyArray<ServerProvider> = models.map(({ instanceId, driver, model }) => ({
    instanceId,
    driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-17T00:00:00.000Z",
    models: [
      {
        slug: model,
        name: model,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: driver === "codex" ? "reasoningEffort" : "effort",
              label: "Reasoning effort",
              type: "select",
              options: [{ id: "medium", label: "Medium" }],
            },
          ],
        },
      },
    ],
    slashCommands: [],
    skills: [],
  }));
  return { policy, providers, layerRegistry: ProviderRegistryMock.layer(providers) };
}
