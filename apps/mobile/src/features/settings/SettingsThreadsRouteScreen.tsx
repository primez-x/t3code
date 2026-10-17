import { AuthSettingsWriteScope, delegationCreditsOverride } from "@t3tools/contracts";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { AutoSettleDaysField } from "./components/AutoSettleDaysField";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import { AppText as Text } from "../../components/ui/AppText";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { NumberField } from "../../components/ui/NumberField";
import { DelegationRoutesEditor } from "./DelegationRoutesEditor";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsProjectOverridesSection } from "./components/SettingsProjectOverridesSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import type { ServerSettingsPatch } from "@t3tools/contracts";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { planAutoSettleSettingsSync, type AutoSettleSettings } from "./autoSettleSettingsSync";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
  type ScopedMobileSettingsTarget,
} from "./settings-scoped-server";

export function SettingsThreadsRouteScreen() {
  const insets = useSafeAreaInsets();

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Thread behavior" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <AutoSettleSettingsRows />
          <DelegationSettingsRows />
          <BetaSettingsSection />
          <LegacySettingsSection />
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays ?? 3;

function DelegationSettingsRows() {
  const { selectedTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  const writableEnvironments = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const [pending, setPending] = useState(false);
  const writeInFlight = useRef(false);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "delegation settings update",
    reportFailure: true,
  });
  const reference = selectedTargets[0]?.serverConfig.settings.delegationPolicy;
  if (!reference) return null;
  const disabled =
    pending ||
    selectedProjectKey !== null ||
    !selectedTargets.every((target) => writableEnvironments.has(target.environmentId));
  const writeToAll = async (
    delegationPolicy: NonNullable<ServerSettingsPatch["delegationPolicy"]>,
  ) => {
    if (
      writeInFlight.current ||
      selectedProjectKey !== null ||
      !selectedTargets.every((target) =>
        readEnvironmentScope(target.environmentId, AuthSettingsWriteScope),
      )
    )
      return false;
    writeInFlight.current = true;
    setPending(true);
    try {
      const results = await Promise.allSettled(
        selectedTargets.map((target) =>
          updateSettings({
            environmentId: target.environmentId,
            input: { patch: { delegationPolicy } },
          }),
        ),
      );
      return results.every(
        (result) => result.status === "fulfilled" && result.value._tag === "Success",
      );
    } finally {
      writeInFlight.current = false;
      setPending(false);
    }
  };
  const uniform = <K extends keyof typeof reference>(key: K) =>
    selectedTargets.every(
      (target) => target.serverConfig.settings.delegationPolicy[key] === reference[key],
    )
      ? reference[key]
      : null;

  const singleTarget = selectedTargets.length === 1 ? selectedTargets[0] : undefined;
  const reserve = uniform("minimumHeadroomPercent");

  return (
    <View className="gap-3">
      <SettingsSection title="Delegation mode">
        <SettingsChoiceRow
          label="Native preferred"
          description="Use provider-native subagents when supported. T3 handles other assignments."
          selected={uniform("mode") === "native-preferred"}
          disabled={disabled}
          onPress={() => writeToAll({ mode: "native-preferred" })}
        />
        <SettingsChoiceRow
          label="T3 managed"
          description="T3 selects providers, models, and effort. Available explicit requests take precedence. T3 also controls native subagent launches."
          separated
          selected={uniform("mode") === "t3-managed"}
          disabled={disabled}
          onPress={() => writeToAll({ mode: "t3-managed" })}
        />
      </SettingsSection>
      <SettingsSection title="Routing priority">
        {(
          [
            [
              "usage",
              "Available quota",
              "Favor capable models with more subscription quota available.",
            ],
            [
              "cost",
              "Lowest estimated cost",
              "Favor capable models with the lowest route cost estimate.",
            ],
            [
              "provider",
              "Preferred provider",
              "Favor the selected provider, or the parent provider when no provider is selected.",
            ],
          ] as const
        ).map(([routingPriority, label, description], index) => (
          <SettingsChoiceRow
            key={routingPriority}
            label={label}
            description={description}
            separated={index > 0}
            selected={uniform("routingPriority") === routingPriority}
            disabled={disabled}
            onPress={() => writeToAll({ routingPriority })}
          />
        ))}
        <SettingsSwitchRow
          icon="arrow.triangle.branch"
          label="Allow target fallback"
          subtitle="Allow a capable substitute when the requested target is unavailable. Off reports the target as unavailable."
          value={uniform("allowFallback")}
          disabled={disabled}
          onValueChange={(allowFallback) => writeToAll({ allowFallback })}
        />
        <View className="gap-2 px-4 py-3">
          <Text className="text-base text-foreground">
            Quota reserve{reserve === null ? " · Mixed" : ""}
          </Text>
          <Text className="text-sm text-foreground-muted">
            Skip providers at or below this percentage. A reserve above zero also excludes unknown
            quota. Zero disables the reserve.
          </Text>
          <NumberField
            label="Quota reserve"
            min={0}
            max={100}
            value={reserve ?? 0}
            formatValue={(value) => `${value}%`}
            disabled={disabled}
            onValueChange={(minimumHeadroomPercent) => writeToAll({ minimumHeadroomPercent })}
          />
        </View>
        {reserve === null ? (
          <SettingsChoiceRow
            label="Clear reserve for selected environments"
            description="Apply zero to every selected environment."
            selected={false}
            disabled={disabled}
            onPress={() => writeToAll({ minimumHeadroomPercent: 0 })}
          />
        ) : null}
        <SettingsSwitchRow
          icon="arrow.triangle.branch"
          label="Model diversity"
          subtitle="Favor another provider or model when candidates rank equally. Off keeps the selected priority without this preference."
          value={uniform("preferAlternateProvider")}
          disabled={disabled}
          onValueChange={(preferAlternateProvider) => writeToAll({ preferAlternateProvider })}
        />
        <SettingsSwitchRow
          icon="ticket"
          label="Allow credits"
          subtitle="Allow paid usage only after subscription quota is exhausted. Off excludes exhausted providers unless a provider override allows paid usage."
          value={uniform("allowCredits")}
          disabled={disabled}
          onValueChange={(allowCredits) => writeToAll({ allowCredits })}
        />
      </SettingsSection>
      {singleTarget ? (
        <>
          <SettingsSection title="Preferred provider">
            <SettingsChoiceRow
              label="Use parent provider"
              description="Use the provider from the parent task."
              selected={reference.preferredProviderInstanceId === null}
              disabled={disabled}
              onPress={() => writeToAll({ preferredProviderInstanceId: null })}
            />
            {singleTarget.serverConfig.providers.map((provider) => (
              <SettingsChoiceRow
                key={provider.instanceId}
                label={provider.displayName ?? provider.instanceId}
                description={provider.instanceId}
                separated
                selected={reference.preferredProviderInstanceId === provider.instanceId}
                disabled={disabled}
                onPress={() => writeToAll({ preferredProviderInstanceId: provider.instanceId })}
              />
            ))}
          </SettingsSection>
          <SettingsSection title="Provider credit overrides">
            <Text className="px-4 py-3 text-sm text-foreground-muted">
              Overrides apply only after subscription quota is exhausted. Use global follows Allow
              credits.
            </Text>
            {singleTarget.serverConfig.providers.map((provider) => (
              <View key={provider.instanceId}>
                <Text className="px-4 py-2 font-t3-medium text-foreground">
                  {provider.displayName ?? provider.instanceId}
                </Text>
                {(
                  [
                    [undefined, "Use global"],
                    [true, "Allow"],
                    [false, "Do not allow"],
                  ] as const
                ).map(([value, label]) => (
                  <SettingsChoiceRow
                    key={label}
                    label={label}
                    separated
                    selected={delegationCreditsOverride(reference, provider.instanceId) === value}
                    disabled={disabled}
                    onPress={() => {
                      const allowCreditsByProvider = { ...reference.allowCreditsByProvider };
                      if (value === undefined) delete allowCreditsByProvider[provider.instanceId];
                      else allowCreditsByProvider[provider.instanceId] = value;
                      writeToAll({ allowCreditsByProvider });
                    }}
                  />
                ))}
              </View>
            ))}
          </SettingsSection>
          <DelegationRoutesEditor
            key={`${singleTarget.environmentId}:${JSON.stringify(reference.routes)}`}
            routes={reference.routes}
            drivers={[
              ...new Set(singleTarget.serverConfig.providers.map((provider) => provider.driver)),
            ]}
            disabled={disabled}
            onChange={(routes) => writeToAll({ routes })}
          />
        </>
      ) : (
        <Text className="px-2 text-sm text-foreground-muted">
          Select one environment to change the preferred provider, provider credit overrides, and
          model routes.
        </Text>
      )}
      <Text className="px-2 text-sm text-foreground-muted">
        Both modes follow the same selection rules. T3 managed enforces those rules. Native
        preferred relies on agent instructions. Changes apply to new delegated tasks and turns after
        the agent session refreshes. The root model stays unchanged.
        {selectedProjectKey !== null
          ? " Select environments to change delegation settings. Projects cannot override these settings."
          : ""}
      </Text>
    </View>
  );
}

function AutoSettleSettingsRows() {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const writableEnvironments = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const projectSelected = selectedProjectKey !== null;
  const [pendingWrites, setPendingWrites] = useState(0);
  const writeInFlight = useRef(false);
  const [pendingTargets, setPendingTargets] = useState<
    readonly ScopedMobileSettingsTarget[] | null
  >(null);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "server settings update",
    reportFailure: true,
  });

  const syncEnvironments = selectedTargets.filter(supportsSharedSettingsSync);
  const syncTargets = resolveMobileSettingsTargets(
    syncEnvironments,
    projectSelected ? (selectedProject?.members.map((member) => member.project) ?? []) : null,
  );
  const canWriteSettings =
    syncTargets.length > 0 &&
    syncTargets.every((target) => writableEnvironments.has(target.environment.environmentId));
  const displayTargets =
    pendingWrites > 0 && pendingTargets !== null ? pendingTargets : syncTargets;
  const reference = displayTargets[0] ?? null;
  const referenceSettings = reference?.settings ?? null;

  if (reference === null || referenceSettings === null) {
    return null;
  }

  const writeToAll = (
    patch: Partial<AutoSettleSettings> & {
      autoResumeLimitedThreads?: boolean;
      snoozeLimitedThreads?: boolean;
    },
  ) => {
    if (
      writeInFlight.current ||
      !syncTargets.every((target) =>
        readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    const writes = planMobileScopedSettingsPatch(syncTargets, projectSelected, patch);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(syncTargets);
    setPendingWrites((count) => count + 1);
    void Promise.allSettled(
      writes.map((entry) =>
        updateSettings({ environmentId: entry.environmentId, input: { patch: entry.patch } }),
      ),
    ).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };

  const { patch: autoSettlePatch, mismatches } = planAutoSettleSettingsSync(
    {
      environmentId: reference.environment.environmentId,
      projectId: reference.projectId,
      settings: referenceSettings,
    },
    displayTargets.map((target) => ({
      environmentId: target.environment.environmentId,
      projectId: target.projectId,
      label: target.environment.label,
      settings: target.settings,
    })),
  );

  const supportsProjectOverrides = syncTargets.every(
    (target) =>
      target.environment.serverConfig.environment.capabilities.projectSettingsOverrides === true,
  );
  const disabled =
    !canWriteSettings || pendingWrites > 0 || (projectSelected && !supportsProjectOverrides);
  const hasProjectOverrides =
    projectSelected &&
    syncTargets.some(
      (target) =>
        target.sources.sidebarAutoSettleOnMerge === "project" ||
        target.sources.sidebarAutoSettleAfterDays === "project",
    );
  const clearProjectOverrides = () => {
    if (
      writeInFlight.current ||
      !syncTargets.every((target) =>
        readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    const writes = planMobileScopedSettingsClear(syncTargets, [
      "sidebarAutoSettleOnMerge",
      "sidebarAutoSettleAfterDays",
    ]);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(syncTargets);
    setPendingWrites((count) => count + 1);
    void Promise.allSettled(
      writes.map((entry) =>
        updateSettings({ environmentId: entry.environmentId, input: { patch: entry.patch } }),
      ),
    ).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };

  const afterDays = referenceSettings.sidebarAutoSettleAfterDays;

  return (
    <View className="gap-6">
      {projectSelected ? (
        <SettingsProjectOverridesSection
          projectLabel={selectedProject?.label ?? "Unavailable project"}
          hasOverrides={hasProjectOverrides}
          supportsOverrides={supportsProjectOverrides}
          pending={pendingWrites > 0}
          disabled={!canWriteSettings}
          onClear={clearProjectOverrides}
        />
      ) : null}
      {!projectSelected ? (
        <SettingsSection title="Usage limits">
          <SettingsSwitchRow
            icon="clock"
            label="Auto-resume limited threads"
            value={uniformMobileSetting(displayTargets, "autoResumeLimitedThreads")}
            disabled={disabled}
            onValueChange={(value) => writeToAll({ autoResumeLimitedThreads: value })}
          />
          <SettingsSwitchRow
            icon="clock"
            label="Snooze limited threads"
            value={uniformMobileSetting(displayTargets, "snoozeLimitedThreads")}
            disabled={disabled}
            onValueChange={(value) => writeToAll({ snoozeLimitedThreads: value })}
          />
        </SettingsSection>
      ) : null}
      <SettingsSection title="Auto-settle">
        <SettingsSwitchRow
          icon="arrow.triangle.branch"
          label="Auto-settle merged threads"
          value={referenceSettings.sidebarAutoSettleOnMerge}
          disabled={disabled}
          onValueChange={(value) => writeToAll({ sidebarAutoSettleOnMerge: value })}
        />
        <SettingsSwitchRow
          icon="clock"
          label="Auto-settle inactive threads"
          value={afterDays !== null}
          disabled={disabled}
          onValueChange={(value) =>
            writeToAll({ sidebarAutoSettleAfterDays: value ? AUTO_SETTLE_DEFAULT_DAYS : null })
          }
        />
        {afterDays !== null ? (
          <View className="flex-row items-center gap-4 px-4 py-4 android:min-h-14 android:py-3">
            <View className="w-[22px] android:w-6" />
            <Text className="flex-1 text-foreground text-lg android:text-base">Inactive days</Text>
            <AutoSettleDaysField
              value={afterDays}
              disabled={disabled}
              onValueChange={(value) => writeToAll({ sidebarAutoSettleAfterDays: value })}
            />
          </View>
        ) : null}
      </SettingsSection>
      {pendingWrites === 0 && mismatches.length > 0 ? (
        <SettingsSection title="Across environments">
          <View className="gap-3 p-4">
            <Text className="text-base text-foreground">Auto-settle defaults differ</Text>
            <Text className="text-sm text-foreground-muted">
              {mismatches.map((mismatch) => mismatch.label).join(", ")}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={disabled}
              onPress={() => writeToAll(autoSettlePatch)}
              className="self-start rounded-full bg-subtle px-4 py-2 active:opacity-70"
            >
              <Text className="text-sm font-t3-medium text-foreground">
                Apply auto-settle defaults
              </Text>
            </Pressable>
          </View>
        </SettingsSection>
      ) : null}
    </View>
  );
}

function BetaSettingsSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const workingShelfEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.workingShelfEnabled === true;

  return (
    <View className="gap-3">
      <SettingsSection title="Beta">
        <SettingsSwitchRow
          icon="bolt.circle"
          label="Working section"
          value={workingShelfEnabled}
          onValueChange={(value) => savePreferences({ workingShelfEnabled: value })}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Fold working and monitoring threads into a Working section. They return to the top of the
        list when they need you. While this is on, active threads are ordered by time and cannot be
        moved.
      </Text>
    </View>
  );
}

function LegacySettingsSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const planModeEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.planModeEnabled === true;

  return (
    <View className="gap-3">
      <SettingsSection title="Legacy">
        <SettingsSwitchRow
          icon="hammer"
          label="Plan Mode"
          value={planModeEnabled}
          onValueChange={(value) => savePreferences({ planModeEnabled: value })}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Opt into retired interfaces kept for compatibility. Plan Mode restores the Build/Plan
        control; otherwise every task runs in Build mode.
      </Text>
    </View>
  );
}
