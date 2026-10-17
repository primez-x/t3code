import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { latestObservation } from "@t3tools/shared/usageLimits";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits {
  return { checkedAt: input.checkedAt, windows: sortWindows(input.windows) };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  if (
    (update.windows.length === 0 &&
      update.credits === undefined &&
      update.extraUsage === undefined) ||
    previous?.unavailable?.reason === "unsupported"
  ) {
    return previous;
  }
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  // Codex sends this notification beside every token-usage tick, almost
  // always with unchanged numbers. Decide "nothing changed" per window on
  // the way through so the no-op case never allocates a new snapshot.
  const credits =
    update.credits === undefined
      ? previous?.credits
      : update.credits === null
        ? undefined
        : latestObservation(previous?.credits, update.credits);
  const extraUsage =
    update.extraUsage === undefined
      ? previous?.extraUsage
      : update.extraUsage === null
        ? undefined
        : latestObservation(previous?.extraUsage, update.extraUsage);
  let windowsChanged = false;
  const paidChanged =
    credits?.checkedAt !== previous?.credits?.checkedAt ||
    extraUsage?.checkedAt !== previous?.extraUsage?.checkedAt ||
    credits?.hasCredits !== previous?.credits?.hasCredits ||
    credits?.unlimited !== previous?.credits?.unlimited ||
    credits?.balance !== previous?.credits?.balance ||
    extraUsage?.enabled !== previous?.extraUsage?.enabled ||
    extraUsage?.available !== previous?.extraUsage?.available ||
    extraUsage?.usedPercent !== previous?.extraUsage?.usedPercent ||
    extraUsage?.coversModelLimits !== previous?.extraUsage?.coversModelLimits;
  for (const window of update.windows) {
    const existing = merged.get(window.id);
    const next: ServerProviderUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
    };
    if (existing === undefined || !usageWindowEquals(existing, next)) {
      merged.set(window.id, next);
      windowsChanged = true;
    }
  }
  if (
    !paidChanged &&
    !windowsChanged &&
    previous !== undefined &&
    previous.unavailable === undefined
  ) {
    return previous;
  }
  return {
    ...makeUsageLimits({
      checkedAt: windowsChanged ? input.checkedAt : (previous?.checkedAt ?? input.checkedAt),
      windows: merged.values(),
    }),
    ...(previous?.credentialFingerprint !== undefined
      ? { credentialFingerprint: previous.credentialFingerprint }
      : {}),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
    ...(credits !== undefined ? { credits } : {}),
    ...(extraUsage !== undefined ? { extraUsage } : {}),
  };
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.modelFamily === b.modelFamily &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins
  );
}

export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  const changedAccount =
    published?.credentialFingerprint !== undefined &&
    probed?.credentialFingerprint !== undefined &&
    published.credentialFingerprint !== probed.credentialFingerprint;
  if (
    probed?.unavailable?.reason === "probeFailed" &&
    published &&
    !published.unavailable &&
    !changedAccount
  ) {
    return published;
  }
  if (!published || !probed || probed.unavailable || changedAccount) return probed;
  const observed =
    latestObservation(published.unavailable ? undefined : published, probed) ?? probed;
  const credits = latestObservation(published.credits, probed.credits);
  const extraUsage = latestObservation(published.extraUsage, probed.extraUsage);
  return observed === probed && credits === probed.credits && extraUsage === probed.extraUsage
    ? probed
    : { ...probed, checkedAt: observed.checkedAt, windows: observed.windows, credits, extraUsage };
}
