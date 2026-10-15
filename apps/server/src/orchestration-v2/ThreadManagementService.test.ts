import { expect, it } from "@effect/vitest";
import {
  CommandId,
  type ServerProvider,
  type DelegationMode,
  type DelegationModelRoute,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ProviderThread,
  ProviderThreadId,
  ProviderDriverKind,
  ProviderSessionId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { DispatchModeLimit, type DispatchModeRefusal } from "./DispatchModeLimit.ts";

it("stamps authoritative provenance on commands that create threads or messages", () => {
  const command: OrchestrationV2Command = {
    type: "thread.create",
    createdBy: "agent",
    creationSource: "mcp",
    commandId: CommandId.make("command:thread-management:create"),
    threadId: ThreadId.make("thread:thread-management:create"),
    projectId: ProjectId.make("project:thread-management"),
    title: "Thread management",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  };

  expect(
    ThreadManagementService.withCreationProvenance(command, {
      createdBy: "user",
      creationSource: "web",
    }),
  ).toMatchObject({
    createdBy: "user",
    creationSource: "web",
  });
});

it("leaves commands that do not create durable authored content unchanged", () => {
  const command: OrchestrationV2Command = {
    type: "run.interrupt",
    commandId: CommandId.make("command:thread-management:interrupt"),
    threadId: ThreadId.make("thread:thread-management:interrupt"),
    runId: RunId.make("run:thread-management:interrupt"),
  };

  expect(
    ThreadManagementService.withCreationProvenance(command, {
      createdBy: "user",
      creationSource: "web",
    }),
  ).toBe(command);
});

it("identifies every existing thread that must be hydrated before dispatch", () => {
  const sourceThreadId = ThreadId.make("thread:thread-management:source");
  const targetThreadId = ThreadId.make("thread:thread-management:target");
  const parentThreadId = ThreadId.make("thread:thread-management:parent");

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:create"),
      threadId: targetThreadId,
      projectId: ProjectId.make("project:thread-management"),
      title: "Created thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    }),
  ).toEqual([]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.archive",
      commandId: CommandId.make("command:thread-management:archive"),
      threadId: targetThreadId,
    }),
  ).toEqual([targetThreadId]);

  // Read-state commands skip transcript hydration entirely: they fire on
  // every activity bump while a thread is open and never touch messages.
  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.visit",
      commandId: CommandId.make("command:thread-management:visit"),
      threadId: targetThreadId,
      visitedAt: "2026-07-30T00:00:00.000Z",
    }),
  ).toEqual([]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.mark-unread",
      commandId: CommandId.make("command:thread-management:mark-unread"),
      threadId: targetThreadId,
    }),
  ).toEqual([]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.fork",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:fork"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: {
        type: "run",
        runId: RunId.make("run:thread-management:source"),
      },
    }),
  ).toEqual([sourceThreadId]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.merge_back",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:merge"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: {
        type: "run",
        runId: RunId.make("run:thread-management:source"),
      },
    }),
  ).toEqual([sourceThreadId, targetThreadId]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "provider",
      commandId: CommandId.make("command:thread-management:delegate"),
      parentThreadId,
      parentRunId: RunId.make("run:thread-management:parent"),
      parentNodeId: NodeId.make("node:thread-management:parent"),
      task: "Inspect the migration",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
    }),
  ).toEqual([parentThreadId]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "delegated_task.wake-policy",
      commandId: CommandId.make("command:thread-management:wake-policy"),
      parentThreadId,
      taskId: NodeId.make("node:thread-management:delegated"),
      completionWake: "always",
    }),
  ).toEqual([parentThreadId]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.created.record",
      commandId: CommandId.make("command:thread-management:record"),
      parentThreadId,
      parentRunId: RunId.make("run:thread-management:parent"),
      parentNodeId: NodeId.make("node:thread-management:parent"),
      targetThreadId,
      targetRunId: null,
    }),
  ).toEqual([parentThreadId, targetThreadId]);
});

it("derives thread management messages from structural error attributes", () => {
  const projectId = ProjectId.make("project:thread-management:errors");
  const threadId = ThreadId.make("thread:thread-management:errors");
  const runId = RunId.make("run:thread-management:errors");
  const messageId = MessageId.make("message:thread-management:errors");
  const infrastructureCause = new Error("private sqlite detail");

  const threadNotFound = new ThreadManagementService.ThreadManagementThreadNotFoundError({
    projectId,
    threadId,
  });
  expect(threadNotFound).toMatchObject({ projectId, threadId });
  expect(threadNotFound.message).toBe(`Thread ${threadId} was not found in project ${projectId}.`);

  const runNotFound = new ThreadManagementService.ThreadManagementRunNotFoundError({
    threadId,
    runId,
  });
  expect(runNotFound).toMatchObject({ threadId, runId });
  expect(runNotFound.message).toBe(`Run ${runId} does not belong to thread ${threadId}.`);

  const archived = new ThreadManagementService.ThreadManagementThreadArchivedError({
    threadId,
  });
  expect(archived).toMatchObject({ threadId });
  expect(archived.message).toBe(`Thread ${threadId} is archived and cannot receive messages.`);

  const notSteerable = new ThreadManagementService.ThreadManagementNoSteerableRunError({
    threadId,
    mode: "restart",
  });
  expect(notSteerable).toMatchObject({
    threadId,
    mode: "restart",
  });
  expect(notSteerable.message).toBe(
    `Thread ${threadId} has no running turn that can be restarted.`,
  );

  const notInterruptible = new ThreadManagementService.ThreadManagementThreadNotInterruptibleError({
    threadId,
    runId,
  });
  expect(notInterruptible).toMatchObject({ threadId, runId });
  expect(notInterruptible.message).toBe(`Run ${runId} is not currently interruptible.`);

  const listFailure = new ThreadManagementService.ThreadManagementProjectThreadsListError({
    projectId,
    cause: infrastructureCause,
  });
  expect(listFailure).toMatchObject({ projectId, cause: infrastructureCause });
  expect(listFailure.message).toBe(`Unable to list threads in project ${projectId}.`);
  expect(listFailure.message).not.toContain(infrastructureCause.message);

  const durableProjectionFailure =
    new ThreadManagementService.ThreadManagementDurableRunProjectionError({
      threadId,
      messageId,
    });
  expect(durableProjectionFailure).toMatchObject({ threadId, messageId });
  expect(durableProjectionFailure.message).toBe(
    `Message ${messageId} was accepted on thread ${threadId} without a durable run projection.`,
  );
});

const layerReceiptsTest = CommandReceiptStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

const layerThreadManagementTest = (settingsLayer: ReturnType<typeof ServerSettings.layerTest>) =>
  ThreadManagementService.layer.pipe(
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([]),
        refreshInstance: () => Effect.succeed([]),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([]),
      }),
    ),
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(Layer.mock(Orchestrator.OrchestratorV2)({})),
    Layer.provide(settingsLayer),
    Layer.provide(layerReceiptsTest),
  );

it.effect("refuses a new turn when the project effectively disables the instance", () => {
  const projectId = ProjectId.make("project:thread-management:gate-disabled");
  const instanceId = ProviderInstanceId.make("codex_work");
  const commandId = CommandId.make("command:thread-management:gate-disabled");
  const layerTest = layerThreadManagementTest(
    ServerSettings.layerTest({
      providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    }),
  );

  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* Effect.flip(
      threads.assertProviderInstanceEnabled({ projectId, commandId, instanceId }),
    );

    expect(error).toBeInstanceOf(
      ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
    );
    expect(error).toMatchObject({ projectId, instanceId });
    expect(error.message).toBe(
      `Provider instance "${instanceId}" is disabled for project ${projectId}.`,
    );
  }).pipe(Effect.provide(layerTest));
});

it.effect("allows a new turn when the project enables an instance the machine disabled", () => {
  const projectId = ProjectId.make("project:thread-management:gate-enabled");
  const instanceId = ProviderInstanceId.make("codex_work");
  const commandId = CommandId.make("command:thread-management:gate-enabled");
  const layerTest = layerThreadManagementTest(
    ServerSettings.layerTest({
      providerInstances: { [instanceId]: { driver: "codex", enabled: false } },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    }),
  );

  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* threads.assertProviderInstanceEnabled({ projectId, commandId, instanceId });
  }).pipe(Effect.provide(layerTest));
});

it.effect("inherits the machine value when the project has no override", () => {
  const projectId = ProjectId.make("project:thread-management:gate-inherit");
  const instanceId = ProviderInstanceId.make("codex_work");
  const commandId = CommandId.make("command:thread-management:gate-inherit");
  const layerTest = layerThreadManagementTest(
    ServerSettings.layerTest({
      providerInstances: { [instanceId]: { driver: "codex", enabled: false } },
    }),
  );

  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* Effect.flip(
      threads.assertProviderInstanceEnabled({ projectId, commandId, instanceId }),
    );

    expect(error).toBeInstanceOf(
      ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
    );
  }).pipe(Effect.provide(layerTest));
});

const layerDispatchChokepointTest =
  (settingsLayer: ReturnType<typeof ServerSettings.layerTest>) => (dispatched: Array<string>) =>
    ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
          refreshInstance: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                id: ThreadId.make("thread:thread-management:chokepoint"),
                projectId: ProjectId.make("project:thread-management:chokepoint"),
                deletedAt: null,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex_work"),
                  model: "test",
                },
              },
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(settingsLayer),
      Layer.provideMerge(layerReceiptsTest),
    );

it.effect(
  "the dispatch chokepoint refuses a continuation message.dispatch on a project-disabled instance before reaching the orchestrator",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-disabled");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const error = yield* Effect.flip(
        threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId,
          messageId: MessageId.make("message:thread-management:chokepoint-disabled"),
          text: "Background task completed.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        }),
      );

      expect(error).toBeInstanceOf(
        ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
      );
      expect(error).toMatchObject({ projectId, instanceId });
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect(
  "a replay of an already-accepted command id dispatches despite the instance now being disabled",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-replay");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      yield* receipts.insertIfAbsent({
        commandId,
        threadId,
        commandType: "message.dispatch",
        acceptedAt: yield* DateTime.now,
        resultSequence: 1,
        status: "accepted",
        error: null,
      });

      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId,
        threadId,
        messageId: MessageId.make("message:thread-management:chokepoint-replay"),
        text: "Background task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });

      expect(dispatched).toEqual(["message.dispatch"]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("classifies projection infrastructure failures separately from a missing thread", () => {
  const projectId = ProjectId.make("project:thread-management:projection-failure");
  const threadId = ThreadId.make("thread:thread-management:projection-failure");
  const infrastructureCause = new Error("sqlite read failed");
  const projectionError = new Orchestrator.OrchestratorProjectionError({
    threadId,
    cause: infrastructureCause,
  });
  const layerTest = ThreadManagementService.layer.pipe(
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([]),
        refreshInstance: () => Effect.succeed([]),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([]),
      }),
    ),
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadProjection: () => Effect.fail(projectionError),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerReceiptsTest),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* Effect.flip(service.getProjectThread({ projectId, threadId }));

    expect(error).toBeInstanceOf(ThreadManagementService.ThreadManagementProjectionLoadError);
    expect(error).toMatchObject({
      projectId,
      threadId,
      cause: projectionError,
    });
    expect(error.message).toBe(`Unable to load thread ${threadId} in project ${projectId}.`);
  }).pipe(Effect.provide(layerTest));
});

it.effect("uses thread-not-found only after a projection loads outside the project", () => {
  const projectId = ProjectId.make("project:thread-management:requested");
  const otherProjectId = ProjectId.make("project:thread-management:other");
  const threadId = ThreadId.make("thread:thread-management:wrong-project");
  const projection = {
    thread: {
      id: threadId,
      projectId: otherProjectId,
      deletedAt: null,
    },
  } as OrchestrationV2ThreadProjection;
  const layerTest = ThreadManagementService.layer.pipe(
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([]),
        refreshInstance: () => Effect.succeed([]),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([]),
      }),
    ),
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadProjection: () => Effect.succeed(projection),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerReceiptsTest),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* Effect.flip(service.getProjectThread({ projectId, threadId }));

    expect(error).toBeInstanceOf(ThreadManagementService.ThreadManagementThreadNotFoundError);
    expect(error).toMatchObject({ projectId, threadId });
    expect("cause" in error).toBe(false);
  }).pipe(Effect.provide(layerTest));
});

it.effect("preserves failed legacy materialization when reading checkpoint context", () => {
  const threadId = ThreadId.make("thread:thread-management:checkpoint-import-failure");
  const importError = new LegacyV1ThreadImporter.LegacyV1ThreadImportError({
    threadId,
    operation: "hydrate transcript for",
    cause: new Error("checkpoint import failed"),
  });
  const layerTest = ThreadManagementService.layerWithLegacyImporter.pipe(
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([]),
        refreshInstance: () => Effect.succeed([]),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([]),
      }),
    ),
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getCheckpointContext: () =>
            Effect.succeed({ runs: [], checkpointScopes: [], checkpoints: [] }),
        }),
        Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
          ensureTranscript: () => Effect.fail(importError),
        }),
      ),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerReceiptsTest),
  );
  return Effect.gen(function* () {
    const service = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* service.getCheckpointContext(threadId).pipe(Effect.flip);
    expect(error).toBeInstanceOf(Orchestrator.OrchestratorProjectionError);
    expect(error).toMatchObject({ threadId, cause: importError });
  }).pipe(Effect.provide(layerTest));
});

it.effect.each([
  { finalStatus: "completed" as const, timedOut: false },
  { finalStatus: "failed" as const, timedOut: false },
  { finalStatus: "cancelled" as const, timedOut: false },
  { finalStatus: "interrupted" as const, timedOut: false },
  { finalStatus: "rolled_back" as const, timedOut: false },
  { finalStatus: "running" as const, timedOut: true },
  { finalStatus: "missing" as const },
])("waitForThread timeout final read when selected run is $finalStatus", (scenario) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-timeout");
    const threadId = ThreadId.make("thread:thread-management:wait-timeout");
    const runId = RunId.make("run:thread-management:wait-timeout");
    const subscribed = yield* Deferred.make<void>();
    let reads = 0;
    const projection = (status: OrchestrationV2Run["status"] | "missing") =>
      ({
        thread: { id: threadId, projectId, deletedAt: null },
        runs: status === "missing" ? [] : [{ id: runId, status }],
      }) as unknown as OrchestrationV2ThreadProjection;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
          refreshInstance: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          // No run update arrives, so the timeout path runs while a final
          // projection read can still observe a terminal run.
          streamStoredEventsFrom: () =>
            Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.never),
            ),
          getThreadRecords: () =>
            Effect.sync(() => {
              reads += 1;
              return projection(reads === 1 ? "running" : scenario.finalStatus);
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({
        projectId,
        threadId,
        runId,
        timeoutMs: 1,
      })
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(subscribed);
    yield* TestClock.adjust(Duration.millis(1));
    const result = yield* Fiber.join(fiber);

    if (scenario.finalStatus === "missing") {
      expect(result._tag).toBe("Failure");
      expect(result).toMatchObject({
        failure: expect.any(ThreadManagementService.ThreadManagementRunNotFoundError),
      });
      expect(result).toMatchObject({
        failure: { threadId, runId },
      });
    } else {
      expect(result._tag).toBe("Success");
      expect(result).toMatchObject({
        success: {
          threadId,
          timedOut: scenario.timedOut,
          run: { id: runId, status: scenario.finalStatus },
        },
      });
    }
  }),
);

it.effect("waitForThread reads the run again only when the run updates", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-event");
    const threadId = ThreadId.make("thread:thread-management:wait-event");
    const runId = RunId.make("run:thread-management:wait-event");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let status: OrchestrationV2Run["status"] = "running";
    let reads = 0;
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
          refreshInstance: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          // Only the run.updated stream carries events in this test.
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.sync(() => {
              reads += 1;
              return {
                thread: { id: threadId, projectId, deletedAt: null },
                runs: [{ id: runId, status }],
              } as unknown as OrchestrationV2ThreadProjection;
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    status = "completed";
    yield* Queue.offer(events, stored(1, { type: "run.updated", payload: { id: "other-run" } }));
    yield* Queue.offer(events, stored(2, { type: "run.updated", payload: { id: runId, status } }));
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({ timedOut: false, run: { id: runId, status: "completed" } });
    // The first read plus one for this run's update. The other run caused none.
    expect(reads).toBe(2);
  }),
);

it.effect("waitForThread follows a restart continuation instead of the cut run", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-restart");
    const threadId = ThreadId.make("thread:thread-management:wait-restart");
    const runId = RunId.make("run:thread-management:wait-restart");
    const continuationId = RunId.make("run:thread-management:wait-restart:2");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    // The restart cut the run; its continuation effect has not started yet.
    let runs: Array<{
      id: RunId;
      status: OrchestrationV2Run["status"];
      restartContinuationOfRunId?: RunId;
    }> = [{ id: runId, status: "cancelled" }];
    let pending = true;
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
          refreshInstance: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: (run) => Effect.succeed(pending && run.id === runId),
          awaitRestartContinuation: () => Effect.never,
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.sync(
              () =>
                ({
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs,
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    const continuation = { id: continuationId, restartContinuationOfRunId: runId };
    runs = [...runs, { ...continuation, status: "running" }];
    pending = false;
    yield* Queue.offer(
      events,
      stored(1, { type: "run.updated", payload: { ...continuation, status: "running" } }),
    );
    runs = [runs[0]!, { ...continuation, status: "completed" }];
    yield* Queue.offer(
      events,
      stored(2, { type: "run.updated", payload: { ...continuation, status: "completed" } }),
    );
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: continuationId, status: "completed" },
    });
  }),
);

it.effect("waitForThread returns the cut run once its continuation is declined", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-declined");
    const threadId = ThreadId.make("thread:thread-management:wait-declined");
    const runId = RunId.make("run:thread-management:wait-declined");
    const subscribed = yield* Deferred.make<void>();
    const declined = yield* Deferred.make<void>();
    let pending = true;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
          refreshInstance: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(pending),
          awaitRestartContinuation: () => Deferred.await(declined),
          // Declining records no thread event.
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.never),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status: "cancelled" }],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    pending = false;
    yield* Deferred.succeed(declined, undefined);
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({ timedOut: false, run: { id: runId, status: "cancelled" } });
  }),
);

it.effect.each([
  "running",
  "missing",
  "completed",
  "unsupported",
  "missing-native-id",
  "wrong-thread",
  "no-session",
  "unsupported-runtime",
  "provider-failed",
  "provider-timeout",
  "within-limit",
  "runtime-raised",
  "interaction-raised",
] as const)("stops a persisted workflow with state %s", (state) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:workflow-stop");
    const subagentId = NodeId.make("node:workflow-stop");
    const runId = RunId.make("run:workflow-stop");
    const providerThreadId = ProviderThreadId.make("provider-thread:workflow-stop");
    const providerSessionId = ProviderSessionId.make("provider-session:workflow-stop");
    const driver = ProviderDriverKind.make("claudeAgent");
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const now = yield* DateTime.now;
    let targetModes: Pick<OrchestrationV2ThreadShell, "runtimeMode" | "interactionMode"> = {
      runtimeMode: "approval-required",
      interactionMode: "plan",
    };
    const task: OrchestrationV2Subagent = {
      id: subagentId,
      threadId,
      runId,
      parentNodeId: NodeId.make("node:workflow-parent"),
      origin: "provider_native",
      createdBy: "agent",
      driver,
      providerInstanceId: instanceId,
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef:
        state === "missing-native-id"
          ? null
          : {
              driver,
              nativeId: "native-workflow-id",
              strength: "strong",
            },
      workflow: { phases: [], agents: [] },
      prompt: "Run the workflow",
      title: null,
      model: null,
      status: state === "completed" ? "completed" : "running",
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      ...(state === "unsupported" ? { driver: ProviderDriverKind.make("codex") } : {}),
    };
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId: instanceId,
      providerSessionId,
      appThreadId: state === "wrong-thread" ? ThreadId.make("other-thread") : threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      contextUsage: null,
      nativeMetadata: null,
      createdAt: now,
      updatedAt: now,
    };
    const calls: Array<{ taskId: string; providerThread: OrchestrationV2ProviderThread }> = [];
    const stopStarted = yield* Deferred.make<void>();
    const runtime = {
      driver,
      providerSessionId,
      instanceId,
      ...(state === "unsupported-runtime"
        ? {}
        : {
            stopTask: (input: (typeof calls)[number]) =>
              state === "provider-failed"
                ? Effect.fail(
                    new ProviderAdapter.ProviderAdapterProtocolError({
                      driver,
                      detail: "private provider detail",
                    }),
                  )
                : state === "provider-timeout"
                  ? Deferred.succeed(stopStarted, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.sync(() => {
                      calls.push(input);
                    }),
          }),
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
          refreshInstance: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: () =>
              Effect.sync(
                () =>
                  ({
                    thread: { id: threadId, deletedAt: null, ...targetModes },
                    subagents: state === "missing" ? [] : [task],
                    runs: [{ id: runId, providerThreadId }],
                    providerThreads: [providerThread],
                  }) as unknown as OrchestrationV2ThreadProjection,
              ),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: (id) => {
              expect(id).toBe(providerSessionId);
              return Effect.succeed(state === "no-session" ? Option.none() : Option.some(runtime));
            },
          }),
        ),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
      const stop = service
        .stopWorkflow({ threadId, subagentId })
        .pipe(
          Effect.provideService(
            DispatchModeLimit,
            state === "within-limit" || state === "runtime-raised" || state === "interaction-raised"
              ? { runtimeMode: "approval-required", interactionMode: "plan", refused }
              : undefined,
          ),
          Effect.result,
        );
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const result =
        state === "runtime-raised" || state === "interaction-raised"
          ? yield* Effect.gen(function* () {
              const started = yield* Deferred.make<void>();
              const pending = yield* executor.withLock(
                threadId,
                Effect.gen(function* () {
                  const fiber = yield* Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(stop),
                    Effect.forkChild,
                  );
                  yield* Deferred.await(started);
                  targetModes =
                    state === "runtime-raised"
                      ? { ...targetModes, runtimeMode: "full-access" }
                      : { ...targetModes, interactionMode: "default" };
                  return fiber;
                }),
              );
              return yield* Fiber.join(pending);
            })
          : state === "provider-timeout"
            ? yield* Effect.gen(function* () {
                const finished = yield* Ref.make(false);
                const pending = yield* stop.pipe(
                  Effect.tap(() => Ref.set(finished, true)),
                  Effect.forkChild,
                );
                yield* Deferred.await(stopStarted);
                yield* TestClock.adjust("15 seconds");
                expect(yield* Ref.get(finished)).toBe(true);
                const result = yield* Fiber.join(pending);
                expect(yield* executor.withLock(threadId, Effect.succeed("lock-released"))).toBe(
                  "lock-released",
                );
                return result;
              })
            : yield* stop;
      if (state === "running" || state === "within-limit") {
        expect(result).toMatchObject({ _tag: "Success" });
        expect(calls).toEqual([{ taskId: "native-workflow-id", providerThread }]);
        expect(task.status).toBe("running");
      } else {
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "OrchestrationV2StopWorkflowError",
            threadId,
            subagentId,
            reason:
              state === "missing" || state === "completed"
                ? "not-running"
                : state === "unsupported" || state === "unsupported-runtime"
                  ? "unsupported"
                  : state === "provider-failed" || state === "provider-timeout"
                    ? "stop-failed"
                    : "unavailable",
          },
        });
        expect(calls).toEqual([]);
        if (state === "provider-timeout") {
          expect(result).toMatchObject({ failure: { cause: { _tag: "TimeoutError" } } });
        }
        if (state === "runtime-raised" || state === "interaction-raised") {
          expect(yield* Ref.get(refused)).toEqual({
            threadId,
            ...targetModes,
            mode: state === "runtime-raised" ? "runtime" : "interaction",
          });
        }
      }
    }).pipe(Effect.provide(Layer.merge(layerTest, ThreadCommandExecutor.layer)));
  }),
);

it.effect.each([
  { status: "completed" as const, settles: true },
  { status: "failed" as const, settles: false },
  { status: "interrupted" as const, settles: false },
])("settleAfterRun settles only when the run $status", ({ status, settles }) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:settle-after-run");
    const threadId = ThreadId.make("thread:thread-management:settle-after-run");
    const runId = RunId.make("run:thread-management:settle-after-run");
    const dispatched: Array<string> = [];
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
          refreshInstance: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status }],
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );

    yield* service.settleAfterRun({ projectId, threadId, runId });

    expect(dispatched).toEqual(settles ? ["thread.settle"] : []);
  }),
);

const delegationParentId = ThreadId.make("thread:delegation-parent");
const delegationProjectId = ProjectId.make("project:delegation");
const delegationProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex_child"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-14T12:00:00Z",
  models: [
    {
      slug: "gpt-6.1-sol",
      name: "Sol",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Effort",
            type: "select",
            options: [{ id: "high", label: "High" }],
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
};
const delegationCommand = (
  options: ReadonlyArray<{ id: string; value: string | boolean }> = [],
) => ({
  type: "delegated_task.request" as const,
  commandId: CommandId.make("command:delegation-central"),
  parentThreadId: delegationParentId,
  parentRunId: RunId.make("run:delegation"),
  parentNodeId: NodeId.make("node:delegation"),
  task: "Implement the bounded change",
  createdBy: "agent" as const,
  creationSource: "mcp" as const,
  modelSelection: {
    instanceId: ProviderInstanceId.make("disabled_hint"),
    model: "unmapped",
    options,
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  role: "implementation" as const,
});
const layerDelegationTest = (
  commands: Array<OrchestrationV2Command>,
  providers = [delegationProvider],
  projectEnabled = true,
  mode: DelegationMode = "t3-managed",
  routes: ReadonlyArray<DelegationModelRoute> = [
    {
      driver: ProviderDriverKind.make("codex"),
      model: "gpt-6.1-sol",
      effort: "high",
      capabilities: ["coding"],
      costPerTask: 0.0372,
    },
  ],
  servingInstanceIds = providers.map((provider) => provider.instanceId),
  projections = new Map<ThreadId, OrchestrationV2ThreadProjection>(),
  reads: Array<{ threadId: ThreadId; fields: ReadonlyArray<string> }> = [],
  hiddenModelsByInstance: Readonly<Record<string, ReadonlyArray<string>>> = {},
  refreshInstance: ProviderRegistry.ProviderRegistry["Service"]["refreshInstance"] = () =>
    Effect.succeed(providers),
  onProviderRead: () => void = () => {},
) => {
  let currentProviders = providers;
  return ThreadManagementService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: (threadId, fields) =>
            Effect.sync(() => {
              reads.push({ threadId, fields });
              return (
                projections.get(threadId) ??
                ({
                  thread: {
                    id: delegationParentId,
                    projectId: delegationProjectId,
                    modelSelection: {
                      instanceId: ProviderInstanceId.make("codex_root"),
                      model: "gpt-6-astra",
                    },
                  },
                  subagents: [],
                  runs: [],
                } as unknown as OrchestrationV2ThreadProjection)
              );
            }),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command as OrchestrationV2Command);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.sync(() => {
            onProviderRead();
            return currentProviders;
          }),
          refreshInstance: (instanceId) =>
            refreshInstance(instanceId).pipe(
              Effect.tap((snapshots) =>
                Effect.sync(() => {
                  currentProviders = [...snapshots];
                }),
              ),
            ),
        }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed(servingInstanceIds),
        }),
        ServerSettings.layerTest({
          providerModelPreferences: Object.fromEntries(
            Object.entries(hiddenModelsByInstance).map(
              ([instanceId, hiddenModels]) =>
                [instanceId, { hiddenModels, modelOrder: [] }] as const,
            ),
          ),
          delegationPolicy: {
            version: 1,
            mode,
            balanceUsage: true,
            preferAlternateProvider: true,
            routes,
          },
          providerInstances: {
            ...providers.reduce(
              (configs, provider) => {
                configs[provider.instanceId] = { driver: provider.driver, enabled: true };
                return configs;
              },
              {} as Record<ProviderInstanceId, { driver: ProviderDriverKind; enabled: boolean }>,
            ),
            [ProviderInstanceId.make("disabled_hint")]: { driver: "codex", enabled: false },
          },
          projectSettingsOverrides: {
            [delegationProjectId]: {
              providerInstances: {
                [ProviderInstanceId.make("codex_child")]: { enabled: projectEnabled },
              },
            },
          },
        }),
        layerReceiptsTest,
      ),
    ),
    Layer.provideMerge(layerReceiptsTest),
  );
};

it.effect("managed automatic delegation replaces a disabled inherited target", () => {
  const commands: Array<OrchestrationV2Command> = [];
  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* threads.dispatch(delegationCommand());
    expect(commands[0]).toMatchObject({
      modelSelection: {
        instanceId: "codex_child",
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      routingDecision: { capability: "coding", role: "implementation", policyVersion: 1 },
    });
  }).pipe(Effect.provide(layerDelegationTest(commands)));
});

it.effect("managed delegation refuses a disabled explicit target without substitution", () => {
  const commands: Array<OrchestrationV2Command> = [];
  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* threads
      .dispatch({ ...delegationCommand(), delegationTargetExplicit: true })
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "OrchestratorCommandRejectedError",
      cause: { _tag: "DelegationSelectionError" },
    });
    expect(commands).toEqual([]);
  }).pipe(Effect.provide(layerDelegationTest(commands)));
});

it.effect("exhausted explicit Claude requests substitute through the full capability map", () => {
  const commands: Array<OrchestrationV2Command> = [];
  const unavailable = {
    ...delegationProvider,
    instanceId: ProviderInstanceId.make("claude_limited"),
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [
      {
        ...delegationProvider.models[0]!,
        slug: "claude-opus-5-5",
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select" as const,
              options: [{ id: "high", label: "High" }],
            },
          ],
        },
      },
    ],
    usageLimits: {
      checkedAt: "1970-01-01T00:00:00Z",
      windows: [
        {
          id: "weekly",
          label: "Weekly",
          kind: "weekly" as const,
          usedPercent: 100,
          resetsAt: "1970-01-01T01:00:00Z",
        },
      ],
    },
  };
  const alternate = {
    ...delegationProvider,
    models: [
      {
        ...delegationProvider.models[0]!,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Effort",
              type: "select" as const,
              options: [{ id: "xhigh", label: "Extra high" }],
            },
          ],
        },
      },
    ],
  };
  const routes = [
    {
      driver: unavailable.driver,
      model: "claude-opus-5-5",
      effort: "high" as const,
      capabilities: ["coding" as const],
      costPerTask: 1,
    },
    {
      driver: alternate.driver,
      model: "gpt-6.1-sol",
      effort: "xhigh" as const,
      capabilities: ["coding" as const],
      costPerTask: 1,
    },
  ];
  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* threads.dispatch({
      ...delegationCommand(),
      delegationTargetExplicit: true,
      modelSelection: {
        instanceId: unavailable.instanceId,
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "high" }],
      },
    });
    expect(commands[0]).toMatchObject({
      modelSelection: {
        instanceId: alternate.instanceId,
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      routingDecision: {
        substitution: {
          requestedModel: "claude-opus-5-5",
          reason: expect.stringContaining("usage"),
        },
      },
    });
  }).pipe(
    Effect.provide(
      layerDelegationTest(commands, [unavailable, alternate], true, "t3-managed", routes),
    ),
  );
});

it.effect("rejects invalid requested options before exhaustion substitution", () => {
  const commands: Array<OrchestrationV2Command> = [];
  const exhausted = {
    ...delegationProvider,
    usageLimits: {
      checkedAt: "1970-01-01T00:00:00Z",
      windows: [
        {
          id: "weekly",
          label: "Weekly",
          kind: "weekly" as const,
          usedPercent: 100,
          resetsAt: "1970-01-01T01:00:00Z",
        },
      ],
    },
  };
  const peer = { ...delegationProvider, instanceId: ProviderInstanceId.make("codex_peer") };
  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* threads
      .dispatch({
        ...delegationCommand(),
        delegationTargetExplicit: true,
        modelSelection: {
          instanceId: exhausted.instanceId,
          model: "gpt-6.1-sol",
          options: [{ id: "unknownOption", value: "invalid" }],
        },
      })
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      cause: { _tag: "ThreadManagementDelegationOptionsError", category: "invalid-options" },
    });
    expect(commands).toEqual([]);
  }).pipe(Effect.provide(layerDelegationTest(commands, [exhausted, peer])));
});

it.effect.each(["advice", "review", "general"] as const)(
  "managed explicit Opus %s survives repeated requests",
  (role) => {
    const commands: Array<OrchestrationV2Command> = [];
    const claude = {
      ...delegationProvider,
      instanceId: ProviderInstanceId.make("claude_review"),
      driver: ProviderDriverKind.make("claudeAgent"),
      models: ["claude-opus-5-5", "claude-fable-5-1"].map((slug) => ({
        ...delegationProvider.models[0]!,
        slug,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select" as const,
              options: [{ id: "high", label: "High" }],
            },
          ],
        },
      })),
    };
    const routes = ["claude-opus-5-5", "claude-fable-5-1"].map((model) => ({
      driver: claude.driver,
      model,
      effort: "high" as const,
      capabilities: ["architecture" as const],
      costPerTask: model.includes("fable") ? 0.1 : 2,
    }));
    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      for (let round = 0; round < 2; round++) {
        yield* threads.dispatch({
          ...delegationCommand(),
          commandId: CommandId.make(`command:opus-review-${round}`),
          role,
          capability: "architecture",
          delegationTargetExplicit: true,
          modelSelection: {
            instanceId: claude.instanceId,
            model: "claude-opus-5-5",
            options: [{ id: "effort", value: "high" }],
          },
        });
      }
      expect(commands).toHaveLength(2);
      for (const command of commands)
        expect(command).toMatchObject({
          modelSelection: { model: "claude-opus-5-5" },
          routingDecision: { reason: "explicit-target" },
        });
    }).pipe(
      Effect.provide(
        layerDelegationTest(commands, [delegationProvider, claude], true, "t3-managed", routes),
      ),
    );
  },
);

it.effect.each(["driver", "instance"] as const)(
  "provider-only %s requests choose a capable model instead of the catalog default",
  (kind) => {
    const commands: Array<OrchestrationV2Command> = [];
    const provider = {
      ...delegationProvider,
      models: [
        { ...delegationProvider.models[0]!, slug: "unmapped-cheap-default" },
        ...delegationProvider.models,
      ],
    };
    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch({
        ...delegationCommand(),
        modelSelection: { instanceId: provider.instanceId, model: "unmapped-cheap-default" },
        delegationTargetExplicit: false,
        delegationProviderConstraint:
          kind === "driver" ? { driver: provider.driver } : { instanceId: provider.instanceId },
      });
      expect(commands[0]).toMatchObject({
        modelSelection: { model: "gpt-6.1-sol" },
        routingDecision: { reason: "explicit-target" },
      });
    }).pipe(Effect.provide(layerDelegationTest(commands, [provider])));
  },
);

it.effect("provider-only requests validate options against the selected model", () => {
  const commands: Array<OrchestrationV2Command> = [];
  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* threads
      .dispatch({
        ...delegationCommand([{ id: "unknownOption", value: "invalid" }]),
        delegationProviderConstraint: { driver: delegationProvider.driver },
      })
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      cause: { _tag: "ThreadManagementDelegationOptionsError", category: "invalid-options" },
    });
    expect(commands).toEqual([]);
  }).pipe(Effect.provide(layerDelegationTest(commands)));
});

it.effect.each([false, true])("provider-only runtime request preserves explicit=%s", (explicit) => {
  const commands: Array<OrchestrationV2Command> = [];
  const provider = {
    ...delegationProvider,
    supportedRuntimeModes: ["approval-required", "full-access"] as const,
  };
  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const request = threads.dispatch({
      ...delegationCommand(),
      runtimeMode: "auto",
      delegationRuntimeModeExplicit: explicit,
      delegationProviderConstraint: { instanceId: provider.instanceId },
    });
    if (explicit) {
      const error = yield* request.pipe(Effect.flip);
      expect(error).toMatchObject({ cause: { _tag: "DelegationSelectionError" } });
      expect(error).toMatchObject({ cause: { message: expect.stringContaining("auto") } });
      expect(commands).toEqual([]);
    } else {
      yield* request;
      expect(commands[0]).toMatchObject({
        runtimeMode: "approval-required",
        modelSelection: { model: "gpt-6.1-sol" },
      });
    }
  }).pipe(Effect.provide(layerDelegationTest(commands, [provider])));
});

it.effect.each(
  [false, true].flatMap((modelPin) =>
    ["exhausted", "disabled"].map((state) => ({ modelPin, state })),
  ),
)(
  "provider driver pools accounts with model pin=$modelPin and first account $state",
  ({ modelPin, state }) => {
    const commands: Array<OrchestrationV2Command> = [];
    const usage = (usedPercent: number) => ({
      checkedAt: "1970-01-01T00:00:00Z",
      windows: [
        {
          id: "weekly",
          label: "Weekly",
          kind: "weekly" as const,
          usedPercent,
          resetsAt: "1970-01-01T01:00:00Z",
        },
      ],
    });
    const first = { ...delegationProvider, usageLimits: usage(state === "exhausted" ? 100 : 20) };
    const peer = {
      ...delegationProvider,
      instanceId: ProviderInstanceId.make("codex_peer"),
      usageLimits: usage(20),
    };
    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch({
        ...delegationCommand(),
        delegationTargetExplicit: modelPin,
        delegationProviderConstraint: { driver: first.driver },
        modelSelection: { instanceId: first.instanceId, model: "gpt-6.1-sol" },
      });
      expect(commands[0]).toMatchObject({
        modelSelection: { instanceId: peer.instanceId, model: "gpt-6.1-sol" },
      });
    }).pipe(Effect.provide(layerDelegationTest(commands, [first, peer], state !== "disabled")));
  },
);

it.effect.each([
  [{ id: "reasoningEffort", value: "max" }],
  [{ id: "reasoningEffort", value: "ultra" }],
  [{ id: "fastMode", value: true }],
  [{ id: "serviceTier", value: "priority" }],
  [{ id: "reasoning", value: "max" }],
  [{ id: "thinkingMode", value: "ultra" }],
  [{ id: "fast", value: true }],
])("delegation refuses forbidden option %j before dispatch", (options) => {
  const commands: Array<OrchestrationV2Command> = [];
  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* threads.dispatch(delegationCommand(options)).pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "OrchestratorCommandRejectedError",
      cause: { _tag: "ThreadManagementDelegationOptionsError" },
    });
    expect(commands).toEqual([]);
  }).pipe(Effect.provide(layerDelegationTest(commands)));
});

it.effect(
  "delegation excludes project-disabled candidates and preserves the capability floor",
  () => {
    const commands: Array<OrchestrationV2Command> = [];
    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const error = yield* threads.dispatch(delegationCommand()).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestratorCommandRejectedError",
        cause: { _tag: "DelegationSelectionError" },
      });
      expect(commands).toEqual([]);
    }).pipe(Effect.provide(layerDelegationTest(commands, [delegationProvider], false)));
  },
);

it.effect(
  "accepted delegation replay skips changed policy catalog quota and forbidden hints",
  () => {
    const commands: Array<OrchestrationV2Command> = [];
    return Effect.gen(function* () {
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const command = delegationCommand([{ id: "reasoningEffort", value: "max" }]);
      yield* receipts.insertIfAbsent({
        commandId: command.commandId,
        threadId: delegationParentId,
        commandType: command.type,
        acceptedAt: yield* DateTime.now,
        resultSequence: 1,
        status: "accepted",
        error: null,
      });
      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch(command);
      expect(commands).toEqual([command]);
    }).pipe(Effect.provide(layerDelegationTest(commands, [])));
  },
);

it.effect.each(["unhealthy", "unregistered", "unsupported-managed-driver"] as const)(
  "central delegation excludes %s candidates",
  (reason) => {
    const commands: Array<OrchestrationV2Command> = [];
    const candidate = {
      ...delegationProvider,
      ...(reason === "unhealthy" ? { installed: false } : {}),
      ...(reason === "unsupported-managed-driver"
        ? { driver: ProviderDriverKind.make("custom") }
        : {}),
    };
    const routes: ReadonlyArray<DelegationModelRoute> = [
      {
        driver: candidate.driver,
        model: "gpt-6.1-sol",
        effort: "high",
        capabilities: ["coding"],
        costPerTask: 0.1,
      },
    ];
    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const error = yield* threads.dispatch(delegationCommand()).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestratorCommandRejectedError",
        cause: { _tag: "DelegationSelectionError" },
      });
      expect(commands).toEqual([]);
    }).pipe(
      Effect.provide(
        layerDelegationTest(
          commands,
          [candidate],
          true,
          "t3-managed",
          routes,
          reason === "unregistered" ? [] : [candidate.instanceId],
        ),
      ),
    );
  },
);

it.effect(
  "an explicit Astra review remains forbidden while a healthy Claude instance can serve Fable",
  () => {
    const commands: Array<OrchestrationV2Command> = [];
    const astra = {
      ...delegationProvider,
      models: [{ ...delegationProvider.models[0]!, slug: "gpt-6-astra" }],
    };
    const claude = {
      ...delegationProvider,
      instanceId: ProviderInstanceId.make("claude_advisor"),
      driver: ProviderDriverKind.make("claudeAgent"),
      models: [
        {
          ...delegationProvider.models[0]!,
          slug: "claude-fable-5-1",
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select" as const,
                options: [{ id: "high", label: "High" }],
              },
            ],
          },
        },
      ],
    };
    const routes: ReadonlyArray<DelegationModelRoute> = [
      {
        driver: astra.driver,
        model: "gpt-6-astra",
        effort: "high",
        capabilities: ["architecture"],
        costPerTask: 0.1476,
      },
      {
        driver: claude.driver,
        model: "claude-fable-5-1",
        effort: "high",
        capabilities: ["architecture"],
        costPerTask: 0.6099,
      },
    ];
    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const error = yield* threads
        .dispatch({
          ...delegationCommand(),
          role: "advice",
          modelSelection: {
            instanceId: astra.instanceId,
            model: "gpt-6-astra",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
          delegationTargetExplicit: true,
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestratorCommandRejectedError",
        cause: { _tag: "DelegationSelectionError" },
      });
      expect(commands).toEqual([]);
    }).pipe(
      Effect.provide(
        layerDelegationTest(commands, [astra, claude], true, "native-preferred", routes),
      ),
    );
  },
);

it.effect(
  "native-preferred automatic choices use policy and explicit capable targets remain valid",
  () => {
    const commands: Array<OrchestrationV2Command> = [];
    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch(delegationCommand());
      yield* threads.dispatch({
        ...delegationCommand(),
        commandId: CommandId.make("explicit-native-child"),
        delegationTargetExplicit: true,
        modelSelection: {
          instanceId: delegationProvider.instanceId,
          model: "gpt-6.1-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      expect(commands).toHaveLength(2);
      expect(
        commands.every(
          (command) =>
            command.type === "delegated_task.request" &&
            command.modelSelection.model === "gpt-6.1-sol" &&
            command.routingDecision?.capability === "coding",
        ),
      ).toBe(true);
    }).pipe(
      Effect.provide(layerDelegationTest(commands, [delegationProvider], true, "native-preferred")),
    );
  },
);

it.effect.each(["root", "nested-writer", "native-writer", "unrelated-fork"] as const)(
  "nested review validates the %s model across the delegated tree",
  (source) => {
    const commands: Array<OrchestrationV2Command> = [];
    const rootId = ThreadId.make("thread:delegation-tree-root");
    const elsewhereId = ThreadId.make("thread:delegation-tree-elsewhere");
    const forkId = ThreadId.make("thread:unrelated-fork");
    const reads: Array<{ threadId: ThreadId; fields: ReadonlyArray<string> }> = [];
    const projection = (
      id: ThreadId,
      model: string,
      parentId: ThreadId | null,
      relationship: "subagent" | "fork" | null,
      subagents: ReadonlyArray<unknown>,
    ): OrchestrationV2ThreadProjection =>
      ({
        thread: {
          id,
          projectId: delegationProjectId,
          modelSelection: { instanceId: delegationProvider.instanceId, model },
          lineage: {
            parentThreadId: parentId,
            relationshipToParent: relationship,
            rootThreadId: rootId,
          },
        },
        subagents,
      }) as unknown as OrchestrationV2ThreadProjection;
    const writer = (
      model: string | null,
      childThreadId: ThreadId | null = null,
      origin = "app_owned",
      selection?: string,
    ) => ({
      origin,
      model,
      childThreadId,
      delegationRole: "implementation",
      status: "completed",
      ...(selection
        ? { modelSelection: { instanceId: delegationProvider.instanceId, model: selection } }
        : {}),
    });
    const projections = new Map([
      [
        delegationParentId,
        projection(delegationParentId, "claude-sonnet-5-5", rootId, "subagent", [
          writer("claude-fable-5-1"),
        ]),
      ],
      [
        rootId,
        projection(rootId, source === "root" ? "gpt-6.1-sol" : "claude-opus-5-5", null, null, [
          writer("claude-sonnet-5-5", delegationParentId),
          writer("claude-sonnet-5-5", elsewhereId),
          writer("unrelated-model", forkId),
          ...(source === "native-writer" ? [writer("gpt-6.1-sol", null, "provider_native")] : []),
        ]),
      ],
      [
        elsewhereId,
        projection(elsewhereId, "claude-sonnet-5-5", rootId, "subagent", [
          writer(
            null,
            null,
            "app_owned",
            source === "nested-writer" ? "gpt-6.1-sol" : "claude-sonnet-5-5",
          ),
          writer("claude-sonnet-5-5", rootId),
        ]),
      ],
      [forkId, projection(forkId, "unrelated-model", rootId, "fork", [writer("gpt-6.1-sol")])],
    ]);
    const claude = {
      ...delegationProvider,
      instanceId: ProviderInstanceId.make("claude_tree"),
      driver: ProviderDriverKind.make("claudeAgent"),
      models: [
        {
          ...delegationProvider.models[0]!,
          slug: "claude-fable-5-1",
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select" as const,
                options: [{ id: "high", label: "High" }],
              },
            ],
          },
        },
      ],
    };
    const routes: ReadonlyArray<DelegationModelRoute> = [
      {
        driver: delegationProvider.driver,
        model: "gpt-6.1-sol",
        effort: "high",
        capabilities: ["architecture"],
        costPerTask: 0.0372,
      },
      {
        driver: claude.driver,
        model: "claude-fable-5-1",
        effort: "high",
        capabilities: ["architecture"],
        costPerTask: 0.6099,
      },
    ];
    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const request = threads.dispatch({
        ...delegationCommand(),
        role: "review",
        delegationTargetExplicit: true,
        modelSelection: {
          instanceId: delegationProvider.instanceId,
          model: "gpt-6.1-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      if (source === "unrelated-fork") {
        yield* request;
        expect(commands[0]).toMatchObject({ modelSelection: { model: "gpt-6.1-sol" } });
      } else {
        const error = yield* request.pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "OrchestratorCommandRejectedError",
          cause: { _tag: "DelegationSelectionError" },
        });
        expect(commands).toEqual([]);
      }
      expect(reads.some((read) => read.threadId === rootId)).toBe(true);
      expect(reads.some((read) => read.threadId === elsewhereId)).toBe(true);
      expect(
        reads
          .filter((read) => read.fields.length > 0)
          .every((read) => read.fields.length === 1 && read.fields[0] === "subagents"),
      ).toBe(true);
      expect(reads.filter((read) => read.threadId === rootId)).toHaveLength(1);
      expect(reads.filter((read) => read.threadId === elsewhereId)).toHaveLength(1);
    }).pipe(
      Effect.provide(
        layerDelegationTest(
          commands,
          [delegationProvider, claude],
          true,
          "native-preferred",
          routes,
          [delegationProvider.instanceId, claude.instanceId],
          projections,
          reads,
        ),
      ),
    );
  },
);

it.effect.each(["automatic", "explicit", "custom"] as const)(
  "central %s delegation respects hidden-model preferences",
  (kind) => {
    const commands: Array<OrchestrationV2Command> = [];
    const cheapModel = {
      ...delegationProvider.models[0]!,
      slug: "cheap-model",
      isCustom: kind === "custom",
    };
    const provider = { ...delegationProvider, models: [cheapModel, ...delegationProvider.models] };
    const routes: ReadonlyArray<DelegationModelRoute> = [
      {
        driver: provider.driver,
        model: "cheap-model",
        effort: "high",
        capabilities: ["coding"],
        costPerTask: 0.001,
      },
      {
        driver: provider.driver,
        model: "gpt-6.1-sol",
        effort: "high",
        capabilities: ["coding"],
        costPerTask: 0.0372,
      },
    ];
    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const request = threads.dispatch({
        ...delegationCommand(),
        delegationTargetExplicit: kind !== "automatic",
        modelSelection: { instanceId: provider.instanceId, model: "cheap-model" },
      });
      if (kind === "explicit") {
        const error = yield* request.pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "OrchestratorCommandRejectedError",
          cause: { _tag: "DelegationSelectionError" },
        });
        expect(commands).toEqual([]);
      } else {
        yield* request;
        expect(commands[0]).toMatchObject({
          modelSelection: { model: kind === "custom" ? "cheap-model" : "gpt-6.1-sol" },
        });
      }
    }).pipe(
      Effect.provide(
        layerDelegationTest(
          commands,
          [provider],
          true,
          "native-preferred",
          routes,
          [provider.instanceId],
          new Map(),
          [],
          { [provider.instanceId]: ["cheap-model"] },
        ),
      ),
    );
  },
);

it.effect(
  "delegation retains verified headroom observed after the initial stale-snapshot check",
  () => {
    const commands: Array<OrchestrationV2Command> = [];
    const richer = { ...delegationProvider, instanceId: ProviderInstanceId.make("codex_richer") };
    const stale = [delegationProvider, richer];
    const refreshedIds: Array<ProviderInstanceId> = [];
    const refreshInstance: ProviderRegistry.ProviderRegistry["Service"]["refreshInstance"] = (
      instanceId,
    ) =>
      Effect.gen(function* () {
        refreshedIds.push(instanceId);
        yield* TestClock.adjust(Duration.seconds(1));
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        return stale.map((provider) => ({
          ...provider,
          usageLimits: {
            checkedAt,
            windows: [
              {
                id: "primary",
                label: "Quota",
                kind: "weekly" as const,
                usedPercent: provider.instanceId === richer.instanceId ? 10 : 80,
                resetsAt: "1970-01-01T01:00:00Z",
              },
            ],
          },
        }));
      });
    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch(delegationCommand());
      expect(commands[0]).toMatchObject({
        modelSelection: { instanceId: richer.instanceId },
        routingDecision: {
          headroomPercent: 90,
          usageCheckedAt: "1970-01-01T00:00:02.000Z",
          reason: "headroom",
        },
      });
      expect(refreshedIds).toEqual(stale.map((provider) => provider.instanceId));
    }).pipe(
      Effect.provide(
        layerDelegationTest(
          commands,
          stale,
          true,
          "t3-managed",
          undefined,
          stale.map((provider) => provider.instanceId),
          new Map(),
          [],
          {},
          refreshInstance,
        ),
      ),
    );
  },
);

it.effect(
  "native explicit delegation emits canonical neutral options once and preserves other advertised options",
  () => {
    const commands: Array<OrchestrationV2Command> = [];
    const provider = {
      ...delegationProvider,
      models: [
        {
          ...delegationProvider.models[0]!,
          capabilities: {
            optionDescriptors: [
              ...delegationProvider.models[0]!.capabilities!.optionDescriptors!,
              {
                id: "serviceTier",
                label: "Service tier",
                type: "select" as const,
                options: [
                  { id: "default", label: "Default" },
                  { id: "priority", label: "Priority" },
                ],
              },
              { id: "fastMode", label: "Fast mode", type: "boolean" as const },
              { id: "customFlag", label: "Custom flag", type: "boolean" as const },
            ],
          },
        },
      ],
    };
    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch({
        ...delegationCommand(),
        delegationTargetExplicit: true,
        modelSelection: {
          instanceId: provider.instanceId,
          model: "gpt-6.1-sol",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "default" },
            { id: "fastMode", value: false },
            { id: "customFlag", value: true },
          ],
        },
      });
      const command = commands[0];
      expect(command?.type).toBe("delegated_task.request");
      if (command?.type !== "delegated_task.request") return;
      expect(
        command.modelSelection.options?.filter((option) => option.id === "serviceTier"),
      ).toEqual([{ id: "serviceTier", value: "default" }]);
      expect(command.modelSelection.options?.filter((option) => option.id === "fastMode")).toEqual([
        { id: "fastMode", value: false },
      ]);
      expect(command.modelSelection.options).toContainEqual({ id: "customFlag", value: true });
    }).pipe(Effect.provide(layerDelegationTest(commands, [provider], true, "native-preferred")));
  },
);

it.effect(
  "delegation probes only stale healthy serving accounts on relevant Codex or Claude drivers",
  () => {
    const commands: Array<OrchestrationV2Command> = [];
    const refreshed: Array<ProviderInstanceId> = [];
    const snapshot = (
      id: string,
      driver: string,
      overrides: Partial<ServerProvider> = {},
    ): ServerProvider => ({
      ...delegationProvider,
      instanceId: ProviderInstanceId.make(id),
      driver: ProviderDriverKind.make(driver),
      ...overrides,
    });
    const muse = snapshot("muse_live", "muse");
    const unsupported = snapshot("custom_live", "custom");
    const irrelevantClaude = snapshot("claude_other_capability", "claudeAgent");
    const unhealthy = snapshot("codex_unhealthy", "codex", { status: "error" });
    const unregistered = snapshot("codex_unregistered", "codex");
    const disabled = snapshot("disabled_hint", "codex");
    const providers = [
      delegationProvider,
      muse,
      unsupported,
      irrelevantClaude,
      unhealthy,
      unregistered,
      disabled,
    ];
    const routes: ReadonlyArray<DelegationModelRoute> = [
      {
        driver: delegationProvider.driver,
        model: "gpt-6.1-sol",
        effort: "high",
        capabilities: ["coding"],
        costPerTask: 0.0372,
      },
      {
        driver: muse.driver,
        model: "gpt-6.1-sol",
        effort: "high",
        capabilities: ["coding"],
        costPerTask: 1,
      },
      {
        driver: unsupported.driver,
        model: "gpt-6.1-sol",
        effort: "high",
        capabilities: ["coding"],
        costPerTask: 1,
      },
      {
        driver: irrelevantClaude.driver,
        model: "gpt-6.1-sol",
        effort: "high",
        capabilities: ["lookup"],
        costPerTask: 1,
      },
    ];
    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch(delegationCommand());
      expect(refreshed).toEqual([delegationProvider.instanceId]);
    }).pipe(
      Effect.provide(
        layerDelegationTest(
          commands,
          providers,
          true,
          "t3-managed",
          routes,
          providers
            .filter((provider) => provider !== unregistered)
            .map((provider) => provider.instanceId),
          new Map(),
          [],
          {},
          (instanceId) =>
            Effect.sync(() => {
              refreshed.push(instanceId);
              return providers;
            }),
        ),
      ),
    );
  },
);

it.effect(
  "stale account probes use two slots and read the aggregated registry once after the batch",
  () =>
    Effect.gen(function* () {
      const commands: Array<OrchestrationV2Command> = [];
      const firstStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const providers = Array.from({ length: 4 }, (_, index) => ({
        ...delegationProvider,
        instanceId: ProviderInstanceId.make(`codex_batch_${index}`),
      }));
      let active = 0;
      let greatestActive = 0;
      let providerReads = 0;
      const started: Array<ProviderInstanceId> = [];
      const refresh: ProviderRegistry.ProviderRegistry["Service"]["refreshInstance"] = (
        instanceId,
      ) =>
        Effect.gen(function* () {
          active += 1;
          greatestActive = Math.max(greatestActive, active);
          started.push(instanceId);
          yield* Deferred.succeed(firstStarted, undefined);
          yield* Deferred.await(release);
          active -= 1;
          return providers;
        });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const dispatched = yield* threads.dispatch(delegationCommand()).pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);
        yield* Effect.yieldNow;
        expect(started).toHaveLength(2);
        expect(providerReads).toBe(1);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(dispatched);
        expect(started).toHaveLength(4);
        expect(greatestActive).toBe(2);
        expect(providerReads).toBe(2);
      }).pipe(
        Effect.provide(
          layerDelegationTest(
            commands,
            providers,
            true,
            "t3-managed",
            undefined,
            providers.map((provider) => provider.instanceId),
            new Map(),
            [],
            {},
            refresh,
            () => {
              providerReads += 1;
            },
          ),
        ),
      );
    }).pipe(Effect.scoped),
);

it.effect(
  "advisor requests persist the architecture floor when a weaker capability was requested",
  () => {
    const commands: Array<OrchestrationV2Command> = [];
    const claude = {
      ...delegationProvider,
      instanceId: ProviderInstanceId.make("claude_floor"),
      driver: ProviderDriverKind.make("claudeAgent"),
      models: [
        {
          ...delegationProvider.models[0]!,
          slug: "claude-fable-5-1",
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select" as const,
                options: [{ id: "high", label: "High" }],
              },
            ],
          },
        },
      ],
    };
    const routes: ReadonlyArray<DelegationModelRoute> = [
      {
        driver: claude.driver,
        model: "claude-fable-5-1",
        effort: "high",
        capabilities: ["architecture"],
        costPerTask: 0.6099,
      },
    ];
    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch({ ...delegationCommand(), role: "advice", capability: "lookup" });
      expect(commands[0]).toMatchObject({
        capability: "architecture",
        routingDecision: { capability: "architecture", role: "advice" },
      });
    }).pipe(Effect.provide(layerDelegationTest(commands, [claude], true, "t3-managed", routes)));
  },
);

it.effect("accepted message replay preserves legacy transcript hydration", () => {
  const threadId = ThreadId.make("accepted-message-transcript");
  const commandId = CommandId.make("accepted-message-transcript-command");
  const hydrated: Array<ThreadId> = [];
  const dependencies = Layer.mergeAll(
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadRecords: () =>
        Effect.succeed({
          thread: {
            projectId: delegationProjectId,
            modelSelection: { instanceId: delegationProvider.instanceId, model: "gpt-6.1-sol" },
          },
        } as unknown as OrchestrationV2ThreadProjection),
      dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
    }),
    Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
      ensureTranscript: (id) =>
        Effect.sync(() => {
          hydrated.push(id);
          return { importedThreadCount: 0, importedMessageCount: 0 };
        }),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed([]),
    }),
    ServerSettings.layerTest(),
    layerReceiptsTest,
  );
  return Effect.gen(function* () {
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    yield* receipts.insertIfAbsent({
      commandId,
      threadId,
      commandType: "message.dispatch",
      acceptedAt: yield* DateTime.now,
      resultSequence: 1,
      status: "accepted",
      error: null,
    });
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId,
      threadId,
      messageId: MessageId.make("accepted-message-transcript-message"),
      text: "Replay",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "mcp",
    });
    expect(hydrated).toEqual([threadId]);
  }).pipe(
    Effect.provide(
      ThreadManagementService.layerWithLegacyImporter.pipe(
        Layer.provide(dependencies),
        Layer.provideMerge(layerReceiptsTest),
      ),
    ),
  );
});
