import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  DelegationCapability,
  DelegationTaskRole,
  type DelegationModelRoute,
  type DelegationPolicy,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";

export class DelegationSelectionError extends Schema.TaggedError<DelegationSelectionError>()(
  "DelegationSelectionError",
  {
    category: Schema.Literals(["no-candidate", "advisor-unavailable"]),
    capability: DelegationCapability,
    role: DelegationTaskRole,
  },
) {
  override get message(): string {
    return this.category === "advisor-unavailable"
      ? "Fable high is unavailable. Astra requires unavailable or exhausted Claude accounts."
      : `No available provider model satisfies capability "${this.capability}" for role "${this.role}" within configured route and option limits.`;
  }
}

export interface DelegationSelectionInput {
  readonly policy: DelegationPolicy;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly parent: ModelSelection;
  readonly capability: DelegationCapability;
  readonly role: DelegationTaskRole;
  readonly nowMs: number;
  readonly excludedReviewerModels?: ReadonlyArray<string>;
  readonly activeAssignments?: ReadonlyArray<ModelSelection>;
  readonly allowedProviderInstanceIds?: ReadonlyArray<ProviderInstanceId>;
  readonly requestedTarget?: ModelSelection;
  readonly hiddenModelsByInstance?: Readonly<Record<string, ReadonlyArray<string>>>;
}

export interface DelegationSelectionDecision {
  readonly policyVersion: 1;
  readonly capability: DelegationCapability;
  readonly role: DelegationTaskRole;
  readonly reason:
    | "advisor-fable"
    | "advisor-fallback"
    | "headroom"
    | "alternate-provider"
    | "alternate-model"
    | "lowest-cost";
  readonly headroomPercent: number | null;
  readonly usageCheckedAt: string | null;
}

export type DelegationSelectionResult =
  | {
      readonly ok: true;
      readonly modelSelection: ModelSelection;
      readonly decision: DelegationSelectionDecision;
    }
  | { readonly ok: false; readonly error: DelegationSelectionError };

interface Quota {
  readonly headroomPercent: number | null;
  readonly usageCheckedAt: string | null;
}

interface Candidate {
  readonly provider: ServerProvider;
  readonly model: ServerProviderModel;
  readonly route: DelegationModelRoute;
  readonly routeIndex: number;
  readonly options: ReadonlyArray<ProviderOptionSelection>;
  readonly quota: Quota;
  readonly activeCount: number;
}

const unknownQuota: Quota = { headroomPercent: null, usageCheckedAt: null };
const effortIds = new Set(["effort", "reasoningEffort"]);
const allowedEfforts = new Set(["low", "medium", "high", "xhigh"]);
function matchesModel(route: DelegationModelRoute, model: ServerProviderModel): boolean {
  if (route.model.endsWith("-*"))
    return !model.isLegacy && isFamily(model.slug, route.model.slice(0, -2));
  return route.model === model.slug || model.aliases?.includes(route.model) === true;
}

function isFamily(model: string, family: string): boolean {
  return model === family || model.startsWith(`${family}-`);
}

function applicableWindow(window: ServerProviderUsageWindow, model: string): boolean {
  if ("modelFamily" in window && typeof window.modelFamily === "string") {
    return isFamily(model, window.modelFamily) || isFamily(model, `claude-${window.modelFamily}`);
  }
  const scope = /^seven_day_(opus|sonnet|fable|haiku)$/.exec(window.id)?.[1];
  return scope === undefined || isFamily(model, `claude-${scope}`);
}

function quotaFor(provider: ServerProvider, model: string, nowMs: number): Quota {
  const limits = provider.usageLimits;
  if (!limits || limits.unavailable || !Number.isFinite(nowMs)) return unknownQuota;
  const checked = DateTime.make(limits.checkedAt);
  if (Option.isNone(checked)) return unknownQuota;
  const checkedMs = DateTime.toEpochMillis(checked.value);
  if (checkedMs > nowMs || nowMs - checkedMs > 300_000) return unknownQuota;
  const windows = limits.windows.filter((window) => applicableWindow(window, model));
  if (windows.length === 0) return unknownQuota;
  let headroomPercent = 100;
  let incomplete = limits.windows.some((window) => window.modelFamily === "unrecognized");
  for (const window of windows) {
    const reset = DateTime.make(window.resetsAt ?? "");
    if (
      Option.isNone(reset) ||
      DateTime.toEpochMillis(reset.value) <= nowMs ||
      !Number.isFinite(window.usedPercent) ||
      window.usedPercent < 0 ||
      window.usedPercent > 100
    ) {
      incomplete = true;
      continue;
    }
    headroomPercent = Math.min(headroomPercent, 100 - window.usedPercent);
  }
  if (incomplete && headroomPercent !== 0) return unknownQuota;
  return { headroomPercent, usageCheckedAt: limits.checkedAt };
}

function canServe(provider: ServerProvider, input: DelegationSelectionInput): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.availability !== "unavailable" &&
    (provider.status === "ready" || provider.status === "warning") &&
    provider.auth.status !== "unauthenticated" &&
    (!input.allowedProviderInstanceIds ||
      input.allowedProviderInstanceIds.includes(provider.instanceId))
  );
}

function optionsFor(
  model: ServerProviderModel,
  effort: DelegationModelRoute["effort"],
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (!allowedEfforts.has(effort)) return undefined;
  const descriptors =
    model.capabilities?.optionDescriptors?.filter((descriptor) => effortIds.has(descriptor.id)) ??
    [];
  if (descriptors.length === 0) return undefined;
  const options: Array<ProviderOptionSelection> = [];
  for (const descriptor of descriptors) {
    if (descriptor.type !== "select" || !descriptor.options.some((choice) => choice.id === effort))
      return undefined;
    options.push({ id: descriptor.id, value: effort });
  }
  for (const descriptor of model.capabilities?.optionDescriptors ?? []) {
    if (
      descriptor.id === "serviceTier" &&
      descriptor.type === "select" &&
      descriptor.options.some((choice) => choice.id === "default")
    ) {
      options.push({ id: descriptor.id, value: "default" });
    } else if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
      options.push({ id: descriptor.id, value: false });
    }
  }
  return options;
}

/** Select from catalog models without provider calls or account data in the decision. */
export function selectDelegationTarget(input: DelegationSelectionInput): DelegationSelectionResult {
  const advisor = input.role === "advice" || input.role === "review";
  const capability = advisor ? "architecture" : input.capability;
  const fail = (category: DelegationSelectionError["category"]): DelegationSelectionResult => ({
    ok: false,
    error: new DelegationSelectionError({
      category,
      capability,
      role: input.role,
    }),
  });
  const usableProviders = input.providers.filter((provider) => canServe(provider, input));
  const claudeAvailable = usableProviders.some((provider) => {
    if (provider.driver !== "claudeAgent") return false;
    const fableModels = provider.models.filter(
      (model) => !model.isCustom && isFamily(model.slug, "claude-fable"),
    );
    const relevantModels =
      fableModels.length > 0 ? fableModels.map((model) => model.slug) : ["claude-fable"];
    return relevantModels.some(
      (model) => quotaFor(provider, model, input.nowMs).headroomPercent !== 0,
    );
  });
  const parentDriver = input.providers.find(
    (provider) => provider.instanceId === input.parent.instanceId,
  )?.driver;
  const excludedModels =
    input.role === "review" ? [input.parent.model, ...(input.excludedReviewerModels ?? [])] : [];
  const excluded = (model: ServerProviderModel) =>
    excludedModels.some(
      (selection) => selection === model.slug || model.aliases?.includes(selection),
    );
  const alternateReview =
    input.role === "review" &&
    claudeAvailable &&
    usableProviders.some(
      (provider) =>
        provider.driver === "claudeAgent" &&
        provider.models.some(
          (model) =>
            !model.isCustom &&
            isFamily(model.slug, "claude-fable") &&
            excluded(model) &&
            quotaFor(provider, model.slug, input.nowMs).headroomPercent !== 0,
        ),
    );
  const fixedAdvisor = advisor && !alternateReview;
  const candidates: Array<Candidate> = [];
  input.policy.routes.forEach((route, routeIndex) => {
    if (!route.capabilities.includes(capability) || (fixedAdvisor && route.effort !== "high"))
      return;
    for (const provider of usableProviders) {
      if (
        provider.driver !== route.driver ||
        (input.requestedTarget && provider.instanceId !== input.requestedTarget.instanceId)
      )
        continue;
      for (const model of provider.models) {
        if (
          !matchesModel(route, model) ||
          excluded(model) ||
          (!model.isCustom &&
            input.hiddenModelsByInstance?.[provider.instanceId]?.includes(model.slug)) ||
          (input.requestedTarget &&
            model.slug !== input.requestedTarget.model &&
            !model.aliases?.includes(input.requestedTarget.model))
        )
          continue;
        const astra = [model.slug, ...(model.aliases ?? [])].some((id) =>
          /(?:^|\/)gpt-\d+(?:\.\d+)?-astra(?:-|$)/.test(id),
        );
        if (
          alternateReview
            ? astra
            : advisor &&
              (model.isCustom ||
                (claudeAvailable
                  ? provider.driver !== "claudeAgent" || !isFamily(model.slug, "claude-fable")
                  : provider.driver !== "codex" || !astra))
        )
          continue;
        const options = optionsFor(model, route.effort);
        if (!options) continue;
        const quota = quotaFor(provider, model.slug, input.nowMs);
        if (quota.headroomPercent === 0) continue;
        candidates.push({
          provider,
          model,
          route,
          routeIndex,
          options,
          quota,
          activeCount:
            input.activeAssignments?.filter(
              (assignment) => assignment.instanceId === provider.instanceId,
            ).length ?? 0,
        });
      }
    }
  });
  if (candidates.length === 0) {
    const catalogFable = usableProviders.flatMap((provider) =>
      provider.driver === "claudeAgent"
        ? provider.models.filter((model) => !model.isCustom && isFamily(model.slug, "claude-fable"))
        : [],
    );
    const configuredFable = catalogFable.some((model) =>
      input.policy.routes.some(
        (route) =>
          route.driver === "claudeAgent" &&
          route.capabilities.includes(capability) &&
          route.effort === "high" &&
          matchesModel(route, model),
      ),
    );
    return fail(
      advisor &&
        claudeAvailable &&
        !alternateReview &&
        (catalogFable.length === 0 || configuredFable)
        ? "advisor-unavailable"
        : "no-candidate",
    );
  }

  // Filter by a fixed maximum before comparison so tolerance cannot produce cyclic rankings.
  const greatestHeadroom = candidates.reduce(
    (greatest, candidate) =>
      Math.max(greatest, candidate.quota.headroomPercent ?? Number.NEGATIVE_INFINITY),
    Number.NEGATIVE_INFINITY,
  );
  const balanced = input.policy.balanceUsage
    ? candidates.filter(
        (candidate) =>
          greatestHeadroom === Number.NEGATIVE_INFINITY ||
          (candidate.quota.headroomPercent !== null &&
            candidate.quota.headroomPercent >= greatestHeadroom - 5),
      )
    : candidates;
  const alternateProvider = (candidate: Candidate) =>
    input.policy.preferAlternateProvider &&
    parentDriver !== undefined &&
    candidate.provider.driver !== parentDriver
      ? 1
      : 0;
  const alternateModel = (candidate: Candidate) =>
    input.policy.preferAlternateProvider &&
    candidate.model.slug !== input.parent.model &&
    !candidate.model.aliases?.includes(input.parent.model)
      ? 1
      : 0;
  balanced.sort(
    (left, right) =>
      alternateProvider(right) - alternateProvider(left) ||
      alternateModel(right) - alternateModel(left) ||
      left.route.costPerTask - right.route.costPerTask ||
      left.activeCount - right.activeCount ||
      left.routeIndex - right.routeIndex ||
      left.provider.instanceId.localeCompare(right.provider.instanceId) ||
      left.model.slug.localeCompare(right.model.slug),
  );
  const chosen = balanced[0]!;
  const reason: DelegationSelectionDecision["reason"] =
    advisor && !alternateReview
      ? claudeAvailable
        ? "advisor-fable"
        : "advisor-fallback"
      : balanced.length < candidates.length
        ? "headroom"
        : alternateProvider(chosen)
          ? "alternate-provider"
          : alternateModel(chosen)
            ? "alternate-model"
            : "lowest-cost";
  return {
    ok: true,
    modelSelection: {
      instanceId: chosen.provider.instanceId,
      model: chosen.model.slug,
      options: chosen.options,
    },
    decision: {
      policyVersion: input.policy.version,
      capability,
      role: input.role,
      reason,
      ...chosen.quota,
    },
  };
}
