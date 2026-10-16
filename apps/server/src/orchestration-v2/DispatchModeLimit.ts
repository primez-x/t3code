import type { ProviderInteractionMode, RuntimeMode, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Ref from "effect/Ref";

export interface DispatchModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface DispatchModeRefusal extends DispatchModes {
  readonly threadId: ThreadId;
  readonly mode: "runtime" | "interaction";
}

/**
 * A caller checks its target's modes before dispatching, but the target's user can raise them
 * meanwhile; the orchestrator re-checks this limit inside the thread's command lock, where nothing
 * else can change them.
 */
export interface DispatchModeLimitValue extends DispatchModes {
  readonly refused?: Ref.Ref<DispatchModeRefusal | undefined>;
}

export const DispatchModeLimit = Context.Reference<DispatchModeLimitValue | undefined>(
  "t3/orchestration-v2/DispatchModeLimit",
  { defaultValue: () => undefined },
);

export const runtimeModeRank: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};
const interactionModeRank: Record<ProviderInteractionMode, number> = { plan: 0, default: 1 };

export const exceededDispatchModeLimit = (
  limit: DispatchModes,
  modes: DispatchModes,
): "runtime" | "interaction" | undefined =>
  runtimeModeRank[modes.runtimeMode] > runtimeModeRank[limit.runtimeMode]
    ? "runtime"
    : interactionModeRank[modes.interactionMode] > interactionModeRank[limit.interactionMode]
      ? "interaction"
      : undefined;

/** Resolve a provider mode within the caller ceiling. Explicit modes never step down. */
export function resolveSupportedRuntimeMode(
  mode: RuntimeMode,
  supported: ReadonlyArray<RuntimeMode> | undefined,
  allowStepDown: boolean,
): RuntimeMode | undefined {
  if (!supported?.length || supported.includes(mode)) return mode;
  if (!allowStepDown) return undefined;
  return supported
    .filter((candidate) => runtimeModeRank[candidate] <= runtimeModeRank[mode])
    .toSorted((left, right) => runtimeModeRank[right] - runtimeModeRank[left])[0];
}
