import { describe, it, assert } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderHost from "./ProviderHost.ts";
import { makeManagedServerProvider } from "./managedProvider.ts";

const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });
const fastModeCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

interface TestSettings {
  readonly enabled: boolean;
}

const maintenanceCapabilities = {
  provider: ProviderDriverKind.make("codex"),
  packageName: "@openai/codex",
  update: {
    command: "npm install -g @openai/codex@latest",

    executable: "npm",

    args: ["install", "-g", "@openai/codex@latest"],

    lockKey: "npm-global",
  },
} as const;

const initialSnapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  message: "Checking provider availability...",
  models: [],
  slashCommands: [],
  skills: [],
};

const refreshedSnapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:01.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const enrichedSnapshot: ServerProvider = {
  ...refreshedSnapshot,
  checkedAt: "2026-04-10T00:00:02.000Z",
  models: [
    {
      slug: "composer-2",
      name: "Composer 2",
      isCustom: false,
      capabilities: fastModeCapabilities,
    },
  ],
};

const refreshedSnapshotSecond: ServerProvider = {
  ...refreshedSnapshot,
  checkedAt: "2026-04-10T00:00:03.000Z",
  message: "Refreshed provider availability again.",
};

function layerProviderHost(input: {
  readonly runBackgroundWork: boolean;
  readonly settings?: Pick<ProviderHost.ProviderHost["Service"], "settings">["settings"];
}) {
  return Layer.succeed(
    ProviderHost.ProviderHost,
    ProviderHost.ProviderHost.of({
      paths: {
        cwd: process.cwd(),
        baseDir: "/t3",
        stateDir: "/t3/userdata",
        providerStatusCacheDir: "/t3/caches",
        attachmentsDir: "/t3/userdata/attachments",
      },
      settings: input.settings ?? {
        get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
        changes: Stream.empty,
        subscribe: Effect.succeed(Stream.empty),
      },
      shouldRunBackgroundWork: () => Effect.succeed(input.runBackgroundWork),
      resolveAttachmentPath: () => null,
      credentials: () => Effect.die("unused"),
    }),
  );
}

const layerAlwaysRunTest = layerProviderHost({ runBackgroundWork: true });
const layerNeverRunTest = layerProviderHost({ runBackgroundWork: false });

const enrichedSnapshotSecond: ServerProvider = {
  ...refreshedSnapshotSecond,
  checkedAt: "2026-04-10T00:00:04.000Z",
  models: [
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      capabilities: emptyCapabilities,
    },
  ],
};

describe("makeManagedServerProvider", () => {
  it.effect(
    "runs the initial provider check in the background and streams the refreshed snapshot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const checkCalls = yield* Ref.make(0);
          const releaseCheck = yield* Deferred.make<void>();
          const provider = yield* makeManagedServerProvider<TestSettings>({
            resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Ref.update(checkCalls, (count) => count + 1).pipe(
              Effect.flatMap(() => Deferred.await(releaseCheck)),
              Effect.as(refreshedSnapshot),
            ),
            refreshInterval: "1 hour",
          });

          const initial = yield* provider.getSnapshot;
          assert.deepStrictEqual(initial, initialSnapshot);

          const updatesFiber = yield* Stream.take(provider.streamChanges, 1).pipe(
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Ref.get(checkCalls), 1);

          yield* Deferred.succeed(releaseCheck, undefined);

          const updates = Array.from(yield* Fiber.join(updatesFiber));
          const latest = yield* provider.getSnapshot;

          assert.deepStrictEqual(updates, [refreshedSnapshot]);
          assert.deepStrictEqual(latest, refreshedSnapshot);
          assert.strictEqual(yield* Ref.get(checkCalls), 1);
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("does not enrich a disabled provider's snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let enrichmentCalls = 0;
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: false }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          refreshOnInterval: false,
          initialSnapshot: () => Effect.succeed({ ...initialSnapshot, enabled: false }),
          checkProvider: Effect.succeed({ ...refreshedSnapshot, enabled: false }),
          enrichSnapshot: () => {
            enrichmentCalls += 1;
            return Effect.void;
          },
        });

        yield* provider.refresh;

        assert.strictEqual(enrichmentCalls, 0);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("skips periodic provider refreshes without foreground provider-status demand", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const initialCheckDone = yield* Deferred.make<void>();
        yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 1
                ? Deferred.succeed(initialCheckDone, undefined).pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.as(refreshedSnapshot),
          ),
          refreshInterval: "1 second",
        });

        yield* Deferred.await(initialCheckDone);
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;

        assert.strictEqual(yield* Ref.get(checkCalls), 1);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(layerNeverRunTest, TestClock.layer()))),
  );

  it.effect("disables periodic provider refreshes when the explicit interval is zero", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const initialCheckDone = yield* Deferred.make<void>();
        yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap(() => Deferred.succeed(initialCheckDone, undefined).pipe(Effect.ignore)),
            Effect.as(refreshedSnapshot),
          ),
          refreshInterval: 0,
        });

        yield* Deferred.await(initialCheckDone);
        yield* TestClock.adjust("5 minutes");
        yield* Effect.yieldNow;

        assert.strictEqual(yield* Ref.get(checkCalls), 1);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(layerAlwaysRunTest, TestClock.layer()))),
  );

  it.effect("keeps manual refresh when interval refresh is disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const initialCheckDone = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 1
                ? Deferred.succeed(initialCheckDone, undefined).pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.as(refreshedSnapshot),
          ),
          refreshInterval: "1 second",
          refreshOnInterval: false,
        });

        yield* Deferred.await(initialCheckDone);
        yield* TestClock.adjust("5 minutes");
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 1);

        yield* provider.refresh;
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(layerAlwaysRunTest, TestClock.layer()))),
  );

  it.effect("wakes a sleeping provider refresh loop when its interval changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const initialServerSettings = {
          ...DEFAULT_SERVER_SETTINGS,
          providerHealthRefreshInterval: Duration.hours(1),
        };
        const serverSettingsRef = yield* Ref.make(initialServerSettings);
        const serverSettingsChanges = yield* PubSub.unbounded<typeof initialServerSettings>();
        const hostSettings: ProviderHost.ProviderHost["Service"]["settings"] = {
          get: Ref.get(serverSettingsRef),
          withSnapshot: (use) => Ref.get(serverSettingsRef).pipe(Effect.flatMap(use)),
          changes: Stream.empty,
          subscribe: PubSub.subscribe(serverSettingsChanges).pipe(
            Effect.map((subscription) => Stream.fromSubscription(subscription)),
          ),
        };
        const checkCalls = yield* Ref.make(0);
        const initialCheckDone = yield* Deferred.make<void>();
        const periodicCheckDone = yield* Deferred.make<void>();

        yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 1
                ? Deferred.succeed(initialCheckDone, undefined).pipe(Effect.ignore)
                : Deferred.succeed(periodicCheckDone, undefined).pipe(Effect.ignore),
            ),
            Effect.as(refreshedSnapshot),
          ),
        }).pipe(
          Effect.provide(layerProviderHost({ runBackgroundWork: true, settings: hostSettings })),
        );

        yield* Deferred.await(initialCheckDone);
        const nextServerSettings = {
          ...initialServerSettings,
          providerHealthRefreshInterval: Duration.seconds(1),
        };
        yield* Ref.set(serverSettingsRef, nextServerSettings);
        yield* PubSub.publish(serverSettingsChanges, nextServerSettings);
        yield* Effect.yieldNow;

        yield* TestClock.adjust("999 millis");
        assert.strictEqual(yield* Ref.get(checkCalls), 1);
        yield* TestClock.adjust("1 millis");
        yield* Deferred.await(periodicCheckDone);
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reruns the provider check when streamed settings change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsRef = yield* Ref.make<TestSettings>({ enabled: true });
        const settingsChanges = yield* PubSub.unbounded<TestSettings>();
        const checkCalls = yield* Ref.make(0);
        const releaseInitialCheck = yield* Deferred.make<void>();
        const releaseSettingsCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Ref.get(settingsRef),
          streamSettings: Stream.fromPubSub(settingsChanges),
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.await(releaseInitialCheck).pipe(Effect.as(refreshedSnapshot))
                : Deferred.await(releaseSettingsCheck).pipe(Effect.as(refreshedSnapshotSecond)),
            ),
          ),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(releaseInitialCheck, undefined);
        yield* Ref.set(settingsRef, { enabled: false });
        yield* PubSub.publish(settingsChanges, { enabled: false });
        yield* Deferred.succeed(releaseSettingsCheck, undefined);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [refreshedSnapshot, refreshedSnapshotSecond]);
        assert.deepStrictEqual(latest, refreshedSnapshotSecond);
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("can update settings and disable periodic checks without probing again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsChanges = yield* PubSub.unbounded<TestSettings>();
        const checkCalls = yield* Ref.make(0);
        const initialCheckDone = yield* Deferred.make<void>();
        const enrichmentCalls = yield* Ref.make(0);
        yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.fromPubSub(settingsChanges),
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          checkProviderOnSettingsChange: () => false,
          refreshOnInterval: false,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap(() => Deferred.succeed(initialCheckDone, undefined).pipe(Effect.ignore)),
            Effect.as(refreshedSnapshot),
          ),
          enrichSnapshot: () => Ref.update(enrichmentCalls, (count) => count + 1),
          refreshInterval: "1 second",
        });

        yield* Deferred.await(initialCheckDone);
        yield* PubSub.publish(settingsChanges, { enabled: false });
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;

        assert.strictEqual(yield* Ref.get(checkCalls), 1);
        assert.strictEqual(yield* Ref.get(enrichmentCalls), 2);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(layerAlwaysRunTest, TestClock.layer()))),
  );

  it.effect("streams supplemental snapshot updates after the base provider check completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseEnrichment = yield* Deferred.make<void>();
        const releaseCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Deferred.await(releaseCheck).pipe(Effect.as(refreshedSnapshot)),
          enrichSnapshot: ({ publishSnapshot }) =>
            Deferred.await(releaseEnrichment).pipe(
              Effect.flatMap(() => publishSnapshot(enrichedSnapshot)),
            ),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(releaseCheck, undefined);

        yield* Deferred.succeed(releaseEnrichment, undefined);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [refreshedSnapshot, enrichedSnapshot]);
        assert.deepStrictEqual(latest, enrichedSnapshot);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("ignores stale enrichment callbacks after a newer refresh advances generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const publishCallbacks: Array<(snapshot: ServerProvider) => Effect.Effect<void>> = [];
        const refreshCount = yield* Ref.make(0);
        const firstCallbackReady = yield* Deferred.make<void>();
        const secondCallbackReady = yield* Deferred.make<void>();
        const allowFirstRefresh = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(refreshCount, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.await(allowFirstRefresh).pipe(Effect.as(refreshedSnapshot))
                : Effect.succeed(refreshedSnapshotSecond),
            ),
          ),
          enrichSnapshot: ({ publishSnapshot }) =>
            Effect.gen(function* () {
              publishCallbacks.push(publishSnapshot);
              if (publishCallbacks.length === 1) {
                yield* Deferred.succeed(firstCallbackReady, undefined).pipe(Effect.ignore);
              } else if (publishCallbacks.length === 2) {
                yield* Deferred.succeed(secondCallbackReady, undefined).pipe(Effect.ignore);
              }
            }),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(allowFirstRefresh, undefined);
        yield* Deferred.await(firstCallbackReady);

        yield* provider.refresh;
        yield* Deferred.await(secondCallbackReady);

        yield* publishCallbacks[0]!(enrichedSnapshot);
        yield* publishCallbacks[1]!(enrichedSnapshotSecond);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [
          refreshedSnapshot,
          refreshedSnapshotSecond,
          enrichedSnapshotSecond,
        ]);
        assert.deepStrictEqual(latest, enrichedSnapshotSecond);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("applies runtime usage updates onto the published snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Effect.succeed({
            ...refreshedSnapshot,
            usageLimits: {
              checkedAt: "2026-04-10T00:00:01.000Z",
              windows: [
                { id: "five_hour", kind: "session", label: "Session", usedPercent: 10 },
                {
                  id: "seven_day",
                  kind: "weekly",
                  label: "Weekly",
                  usedPercent: 20,
                  resetsAt: "2026-04-17T00:00:00.000Z",
                },
              ],
            },
          } satisfies ServerProvider),
          refreshInterval: "1 hour",
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);

        const updatesFiber = yield* Stream.take(provider.streamChanges, 1).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:05:00.000Z",
          windows: [{ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 25 }],
        });
        yield* provider.applyUsageLimits({ checkedAt: "2026-04-10T00:06:00.000Z", windows: [] });

        const [update] = Array.from(yield* Fiber.join(updatesFiber));
        assert.deepStrictEqual(update?.usageLimits, {
          checkedAt: "2026-04-10T00:05:00.000Z",
          windows: [
            { id: "five_hour", kind: "session", label: "Session", usedPercent: 10 },
            {
              id: "seven_day",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 25,
              resetsAt: "2026-04-17T00:00:00.000Z",
            },
          ],
        });
        assert.deepStrictEqual(yield* provider.getSnapshot, update);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect.each([false, true])(
    "does not use paid timestamps as quota clocks with runtime=%s",
    (withRuntime) =>
      Effect.scoped(
        Effect.gen(function* () {
          const paidAt = "2026-04-10T12:20:00.000Z";
          const credits = { checkedAt: paidAt, hasCredits: true, unlimited: false };
          const probeRef = yield* Ref.make<ServerProvider>({
            ...refreshedSnapshot,
            auth: { ...refreshedSnapshot.auth, workspaceId: "org-a" },
            usageLimits: { checkedAt: paidAt, windows: [], credits },
          });
          const provider = yield* makeManagedServerProvider<TestSettings>({
            resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Ref.get(probeRef),
            refreshOnInterval: false,
          });
          yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
          const window = {
            id: "primary",
            kind: "session",
            label: "Session",
            usedPercent: 95,
          } as const;
          if (withRuntime) {
            yield* provider.applyUsageLimits({
              checkedAt: "2026-04-10T12:05:00.000Z",
              windows: [window],
            });
            assert.deepStrictEqual((yield* provider.getSnapshot).usageLimits?.windows, [window]);
          }
          yield* Ref.set(probeRef, {
            ...refreshedSnapshot,
            auth: { ...refreshedSnapshot.auth, workspaceId: "org-a" },
            usageLimits: {
              checkedAt: "2026-04-10T12:06:00.000Z",
              windows: [{ ...window, usedPercent: 20 }],
            },
          });
          const refreshed = yield* provider.refresh;
          assert.strictEqual(refreshed.usageLimits?.windows[0]?.usedPercent, 20);
          assert.deepStrictEqual(refreshed.usageLimits?.credits, credits);
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect.each([false, true])(
    "keeps silent quota confirmations and separate paid clocks with stale runtime=%s",
    (staleRuntime) =>
      Effect.scoped(
        Effect.gen(function* () {
          const quotaAt = "2026-04-10T12:05:00.000Z";
          const confirmedAt = "2026-04-10T12:10:00.000Z";
          const credits = { checkedAt: quotaAt, hasCredits: true, unlimited: false, balance: "20" };
          const window = {
            id: "primary",
            kind: "session",
            label: "Session",
            usedPercent: 95,
          } as const;
          const probeRef = yield* Ref.make<ServerProvider>({
            ...refreshedSnapshot,
            auth: { ...refreshedSnapshot.auth, workspaceId: "org-a" },
            usageLimits: { checkedAt: quotaAt, windows: [window], credits },
          });
          const provider = yield* makeManagedServerProvider<TestSettings>({
            resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Ref.get(probeRef),
            refreshOnInterval: false,
          });
          yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
          const original = yield* provider.getSnapshot;
          const nextPublished = yield* Stream.take(provider.streamChanges, 1).pipe(
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          for (const checkedAt of [confirmedAt, "2026-04-10T12:09:00.000Z"]) {
            yield* provider.applyUsageLimits({ checkedAt, windows: [window] });
          }
          assert.strictEqual(yield* provider.getSnapshot, original);
          yield* provider.applyUsageLimits({
            checkedAt: "2026-04-10T12:09:00.000Z",
            windows: staleRuntime ? [{ ...window, usedPercent: 20 }] : [],
            credits: { ...credits, checkedAt: "2026-04-10T12:11:00.000Z", balance: "10" },
          });
          const [paidUpdate] = Array.from(yield* Fiber.join(nextPublished));
          assert.deepStrictEqual(paidUpdate?.usageLimits?.windows, [window]);
          assert.strictEqual(paidUpdate?.usageLimits?.checkedAt, quotaAt);
          assert.strictEqual(paidUpdate?.usageLimits?.credits?.balance, "10");
          yield* Ref.set(probeRef, {
            ...refreshedSnapshot,
            auth: { ...refreshedSnapshot.auth, workspaceId: "org-a" },
            usageLimits: {
              checkedAt: "2026-04-10T12:09:30.000Z",
              windows: [{ ...window, usedPercent: 20 }],
              credits,
            },
          });
          const reconciled = yield* provider.refresh;
          assert.deepStrictEqual(reconciled.usageLimits?.windows, [window]);
          assert.strictEqual(reconciled.usageLimits?.checkedAt, confirmedAt);
          assert.strictEqual(
            reconciled.usageLimits?.credits?.checkedAt,
            "2026-04-10T12:11:00.000Z",
          );
          yield* Ref.set(probeRef, {
            ...refreshedSnapshot,
            auth: { ...refreshedSnapshot.auth, workspaceId: "org-a" },
            usageLimits: {
              checkedAt: "2026-04-10T12:10:30.000Z",
              windows: [{ ...window, usedPercent: 0 }],
              credits,
            },
          });
          assert.strictEqual((yield* provider.refresh).usageLimits?.windows[0]?.usedPercent, 0);
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect.each(
    (
      [
        {
          name: "lost workspace",
          previousWorkspace: "org-a",
          nextAuth: { status: "authenticated", email: "same@example.com" },
        },
        {
          name: "unknown workspaces",
          nextAuth: { status: "authenticated", email: "same@example.com" },
        },
        {
          name: "failed auth initialization",
          previousWorkspace: "org-a",
          nextAuth: { status: "unknown" },
        },
        {
          name: "recovered workspace metadata",
          nextAuth: { status: "authenticated", email: "same@example.com", workspaceId: "org-a" },
        },
        {
          name: "changed credential",
          previousWorkspace: "org-a",
          previousFingerprint: "credential-a",
          nextFingerprint: "credential-b",
          nextAuth: { status: "authenticated", email: "same@example.com", workspaceId: "org-a" },
        },
        {
          name: "changed email",
          previousWorkspace: "org-a",
          previousFingerprint: "credential-a",
          nextFingerprint: "credential-a",
          nextAuth: { status: "authenticated", email: "other@example.com", workspaceId: "org-a" },
        },
        {
          name: "changed workspace with matching credential",
          previousWorkspace: "org-a",
          previousFingerprint: "credential-a",
          nextFingerprint: "credential-a",
          nextAuth: { status: "authenticated", email: "same@example.com", workspaceId: "org-b" },
        },
        {
          name: "unauthenticated workspace metadata",
          previousWorkspace: "org-a",
          nextAuth: { status: "unauthenticated", email: "same@example.com", workspaceId: "org-a" },
        },
      ] satisfies ReadonlyArray<{
        name: string;
        previousWorkspace?: string;
        previousFingerprint?: string;
        nextFingerprint?: string;
        nextAuth: ServerProvider["auth"];
      }>
    ).flatMap((scenario) =>
      [false, true].flatMap((failed) =>
        [false, true].map((available) => ({ ...scenario, failed, available })),
      ),
    ),
  )(
    "requires verified continuity for $name with failed=$failed and previous allowance=$available",
    (scenario) =>
      Effect.scoped(
        Effect.gen(function* () {
          const checkedAt = "2026-04-10T12:20:00.000Z";
          const oldSnapshot: ServerProvider = {
            ...refreshedSnapshot,
            auth: {
              status: "authenticated",
              email: "same@example.com",
              workspaceId: scenario.previousWorkspace,
            },
            usageLimits: {
              checkedAt,
              credentialFingerprint: scenario.previousFingerprint,
              windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 95 }],
              extraUsage: {
                checkedAt,
                enabled: true,
                available: scenario.available,
                coversModelLimits: true,
              },
              credits: { checkedAt, hasCredits: scenario.available, unlimited: false },
              resetCredits: { availableCount: 2, nextCreditId: "old-credit" },
            },
          };
          const probeRef = yield* Ref.make(oldSnapshot);
          const provider = yield* makeManagedServerProvider<TestSettings>({
            resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Ref.get(probeRef),
            refreshOnInterval: false,
          });
          yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
          const next: ServerProvider = {
            ...refreshedSnapshot,
            auth: scenario.nextAuth,
            usageLimits: {
              checkedAt: "2026-04-10T12:06:00.000Z",
              credentialFingerprint: scenario.nextFingerprint,
              windows: scenario.failed
                ? []
                : [{ id: "primary", kind: "session", label: "Session", usedPercent: 5 }],
              ...(scenario.failed ? { unavailable: { reason: "probeFailed" as const } } : {}),
            },
          };
          yield* Ref.set(probeRef, next);
          const refreshed = yield* provider.refresh;
          assert.deepStrictEqual(refreshed.usageLimits, next.usageLimits);
          assert.deepStrictEqual(refreshed.auth, next.auth);
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect.each([false, true])(
    "reports only the fresh paid observation across an identity gap with available=%s",
    (available) =>
      Effect.scoped(
        Effect.gen(function* () {
          const checkedAt = "2026-04-10T12:20:00.000Z";
          const oldSnapshot: ServerProvider = {
            ...refreshedSnapshot,
            auth: { status: "authenticated", email: "same@example.com", workspaceId: "org-a" },
            usageLimits: {
              checkedAt,
              windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 95 }],
              extraUsage: {
                checkedAt,
                enabled: true,
                available: !available,
                coversModelLimits: true,
              },
              credits: { checkedAt, hasCredits: !available, unlimited: false },
              resetCredits: { availableCount: 2 },
            },
          };
          const probeRef = yield* Ref.make(oldSnapshot);
          const provider = yield* makeManagedServerProvider<TestSettings>({
            resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Ref.get(probeRef),
            refreshOnInterval: false,
          });
          yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
          const probeAt = "2026-04-10T12:06:00.000Z";
          const next: ServerProvider = {
            ...refreshedSnapshot,
            auth: { status: "authenticated", email: "same@example.com" },
            usageLimits: {
              checkedAt: probeAt,
              windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 5 }],
              extraUsage: { checkedAt: probeAt, enabled: true, available, coversModelLimits: true },
            },
          };
          yield* Ref.set(probeRef, next);
          assert.deepStrictEqual(yield* provider.refresh, next);
          const recovered: ServerProvider = { ...next, auth: oldSnapshot.auth };
          yield* Ref.set(probeRef, recovered);
          assert.deepStrictEqual(yield* provider.refresh, recovered);
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect.each(
    ["workspace", "credential", "workspace and credential"].flatMap((identity) =>
      [false, true].map((failed) => ({ identity, failed })),
    ),
  )(
    "preserves independent clocks with verified $identity continuity and failed=$failed",
    ({ identity, failed }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const quotaAt = "2026-04-10T12:05:00.000Z";
          const paidAt = "2026-04-10T12:20:00.000Z";
          const oldSnapshot: ServerProvider = {
            ...refreshedSnapshot,
            auth: { status: "authenticated", email: "same@example.com", workspaceId: "org-a" },
            usageLimits: {
              checkedAt: quotaAt,
              ...(identity !== "workspace" ? { credentialFingerprint: "credential-a" } : {}),
              windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 95 }],
              extraUsage: {
                checkedAt: paidAt,
                enabled: true,
                available: true,
                coversModelLimits: true,
              },
              credits: { checkedAt: paidAt, hasCredits: true, unlimited: false },
              resetCredits: { availableCount: 2 },
            },
          };
          const probeRef = yield* Ref.make(oldSnapshot);
          const provider = yield* makeManagedServerProvider<TestSettings>({
            resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Ref.get(probeRef),
            refreshOnInterval: false,
          });
          yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
          const next: ServerProvider = {
            ...refreshedSnapshot,
            auth: {
              ...oldSnapshot.auth,
              ...(identity === "credential" ? { workspaceId: undefined } : {}),
            },
            usageLimits: {
              checkedAt: "2026-04-10T12:06:00.000Z",
              ...(identity !== "workspace" ? { credentialFingerprint: "credential-a" } : {}),
              windows: failed
                ? []
                : [{ id: "primary", kind: "session", label: "Session", usedPercent: 5 }],
              ...(failed
                ? { unavailable: { reason: "probeFailed" as const } }
                : {
                    extraUsage: {
                      checkedAt: quotaAt,
                      enabled: true,
                      available: false,
                      coversModelLimits: true,
                    },
                  }),
            },
          };
          yield* Ref.set(probeRef, next);
          const refreshed = yield* provider.refresh;
          assert.deepStrictEqual(
            refreshed.usageLimits?.extraUsage,
            oldSnapshot.usageLimits?.extraUsage,
          );
          assert.deepStrictEqual(refreshed.usageLimits?.credits, oldSnapshot.usageLimits?.credits);
          assert.deepStrictEqual(
            refreshed.usageLimits?.windows,
            failed ? oldSnapshot.usageLimits?.windows : next.usageLimits?.windows,
          );
          assert.strictEqual(
            refreshed.usageLimits?.checkedAt,
            failed ? quotaAt : next.usageLimits?.checkedAt,
          );
          if (failed) {
            assert.deepStrictEqual(
              refreshed.usageLimits?.resetCredits,
              oldSnapshot.usageLimits?.resetCredits,
            );
            assert.strictEqual(refreshed.auth.workspaceId, "org-a");
          }
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect.each([false, true])(
    "discards previous paid usage after a same-email workspace switch with failed=%s",
    (failed) =>
      Effect.scoped(
        Effect.gen(function* () {
          const checkedAt = "2026-04-10T12:05:00.000Z";
          const oldSnapshot: ServerProvider = {
            ...refreshedSnapshot,
            auth: { status: "authenticated", email: "same@example.com", workspaceId: "org-a" },
            usageLimits: {
              checkedAt,
              windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 95 }],
              extraUsage: { checkedAt, enabled: true, available: true, coversModelLimits: true },
              credits: { checkedAt, hasCredits: true, unlimited: false },
            },
          };
          const probeRef = yield* Ref.make(oldSnapshot);
          const provider = yield* makeManagedServerProvider<TestSettings>({
            resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Ref.get(probeRef),
            refreshOnInterval: false,
          });
          yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
          yield* provider.applyUsageLimits({
            checkedAt: "2026-04-10T12:10:00.000Z",
            windows: oldSnapshot.usageLimits!.windows,
          });
          const next: ServerProvider = {
            ...oldSnapshot,
            auth: { ...oldSnapshot.auth, workspaceId: "org-b" },
            usageLimits: failed
              ? {
                  checkedAt: "2026-04-10T12:20:00.000Z",
                  windows: [],
                  unavailable: { reason: "probeFailed" },
                }
              : {
                  checkedAt,
                  windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 20 }],
                },
          };
          yield* Ref.set(probeRef, next);
          const switched = yield* provider.refresh;
          assert.deepStrictEqual(switched.usageLimits, next.usageLimits);
          assert.strictEqual(switched.auth.workspaceId, "org-b");
          yield* provider.applyUsageLimits({
            checkedAt: "2026-04-10T12:06:00.000Z",
            windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 30 }],
          });
          assert.strictEqual(
            (yield* provider.getSnapshot).usageLimits?.windows[0]?.usedPercent,
            30,
          );
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("keeps live usage windows across a failed probe and a stale enrichment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseEnrichment = yield* Deferred.make<void>();
        const refreshCount = yield* Ref.make(0);
        const probedLimits = {
          checkedAt: "2026-04-10T00:00:01.000Z",
          windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 10 }],
        } as const;
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(refreshCount, (count) => count + 1).pipe(
            Effect.map((count) =>
              count === 1
                ? {
                    ...refreshedSnapshot,
                    auth: { ...refreshedSnapshot.auth, workspaceId: "ws-a" },
                    usageLimits: probedLimits,
                  }
                : {
                    ...refreshedSnapshotSecond,
                    auth: {
                      ...refreshedSnapshotSecond.auth,
                      workspaceId: count === 3 ? "ws-b" : "ws-a",
                    },
                    usageLimits: {
                      checkedAt: "2026-04-10T00:00:03.000Z",
                      windows: [],
                      unavailable: { reason: "probeFailed" },
                    },
                  },
            ),
          ),
          enrichSnapshot: ({ snapshot, publishSnapshot }) =>
            Deferred.await(releaseEnrichment).pipe(
              Effect.flatMap(() =>
                publishSnapshot({
                  ...enrichedSnapshot,
                  ...snapshot,
                  models: enrichedSnapshot.models,
                }),
              ),
            ),
          refreshInterval: "1 hour",
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);

        const liveWindow = {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 60,
        } as const;
        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:00:02.000Z",
          windows: [liveWindow],
        });

        yield* Deferred.succeed(releaseEnrichment, undefined);
        const enriched = yield* Stream.take(provider.streamChanges, 1).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)[0]!),
        );
        assert.deepStrictEqual(enriched.models, enrichedSnapshot.models);
        assert.deepStrictEqual(enriched.usageLimits?.windows, [liveWindow]);

        const refreshed = yield* provider.refresh;
        assert.strictEqual(refreshed.message, refreshedSnapshotSecond.message);
        assert.deepStrictEqual(refreshed.usageLimits?.windows, [liveWindow]);
        assert.strictEqual(refreshed.auth.workspaceId, "ws-a");

        const switched = yield* provider.refresh;
        assert.strictEqual(switched.auth.workspaceId, "ws-b");
        assert.strictEqual(switched.usageLimits?.unavailable?.reason, "probeFailed");
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );
});
