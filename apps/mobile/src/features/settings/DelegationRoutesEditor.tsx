import {
  DelegationCapability,
  DelegationModelRoute,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const isDelegationModelRoute = Schema.is(DelegationModelRoute);

const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const TASK_LEVEL_LABELS = {
  lookup: "Lookup · exact facts",
  discovery: "Discovery · bounded research",
  mechanical: "Mechanical · decided edits",
  routine: "Routine · bounded implementation",
  coding: "Coding · code and workflows",
  substantial: "Substantial · larger implementation",
  architecture: "Architecture · diagnosis, design, advice, review",
} satisfies Record<DelegationCapability, string>;

export function DelegationRoutesEditor(props: {
  readonly routes: readonly DelegationModelRoute[];
  readonly drivers: readonly ProviderDriverKind[];
  readonly disabled: boolean;
  readonly onChange: (routes: readonly DelegationModelRoute[]) => void;
}) {
  const [draft, setDraft] = useState<{
    index: number | null;
    driver: string;
    model: string;
    effort: DelegationModelRoute["effort"];
    capabilities: readonly DelegationCapability[];
    cost: string;
  } | null>(null);
  const candidate = draft
    ? {
        driver: draft.driver.trim(),
        model: draft.model.trim(),
        effort: draft.effort,
        capabilities: draft.capabilities,
        costPerTask: Number(draft.cost),
      }
    : null;
  const valid =
    candidate !== null &&
    draft !== null &&
    /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(draft.cost.trim()) &&
    candidate.capabilities.length > 0 &&
    /^[^\s*]+(?:-\*)?$/.test(candidate.model) &&
    isDelegationModelRoute(candidate);

  return (
    <SettingsSection title="Model routes">
      <Text className="px-4 py-3 text-sm text-foreground-muted">
        Set task levels, effort, and estimated cost for each model. Cost estimates compare routes;
        estimates are not actual charges or spend limits. Custom routes replace the default list.
        Remove every custom route to restore defaults.
      </Text>
      {props.routes.length === 0 ? (
        <Text className="px-4 pb-3 text-sm text-foreground-muted">No custom model routes.</Text>
      ) : null}
      {props.routes.map((route, index) => (
        <View
          // oxlint-disable-next-line react/no-array-index-key -- Routes have no IDs, allow duplicate values, and rows hold no local state.
          key={`${index}:${route.driver}:${route.model}`}
          className="gap-2 border-t border-border-subtle px-4 py-3"
        >
          <Text className="font-t3-medium text-foreground">
            {route.driver} / {route.model}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {route.effort} · {route.capabilities.join(", ")} · Estimated cost {route.costPerTask}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <Button
              label="Edit route"
              disabled={props.disabled || draft !== null}
              onPress={() => setDraft({ index, ...route, cost: String(route.costPerTask) })}
            />
            <Button
              label="Delete route"
              tone="danger"
              disabled={props.disabled || draft !== null}
              onPress={() =>
                props.onChange(props.routes.filter((_, routeIndex) => routeIndex !== index))
              }
            />
          </View>
        </View>
      ))}
      {draft === null ? (
        <View className="px-4 py-3">
          <Button
            label="Add route"
            disabled={props.disabled}
            onPress={() =>
              setDraft({
                index: null,
                driver: props.drivers[0] ?? "",
                model: "",
                effort: "high",
                capabilities: [],
                cost: "",
              })
            }
          />
        </View>
      ) : (
        <View className="gap-3 border-t border-border-subtle py-3">
          <View className="gap-2 px-4">
            <Text className="font-t3-medium text-foreground">
              {draft.index === null ? "Add route" : "Edit route"}
            </Text>
            <Text className="text-sm text-foreground-muted">
              Provider driver: {props.drivers.join(", ") || "Enter a provider driver ID"}.
            </Text>
            <AppTextInput
              accessibilityLabel="Provider driver"
              value={draft.driver}
              onChangeText={(driver) => setDraft({ ...draft, driver })}
              editable={!props.disabled}
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
            />
            <Text className="text-sm text-foreground-muted">
              Use an exact model ID or a family pattern ending in -*, such as gpt-6-*.
            </Text>
            <AppTextInput
              accessibilityLabel="Model ID or family pattern"
              placeholder="Model ID or family-*"
              value={draft.model}
              onChangeText={(model) => setDraft({ ...draft, model })}
              editable={!props.disabled}
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
            />
            <Text className="text-sm text-foreground-muted">
              Estimated cost per task · zero or greater
            </Text>
            <AppTextInput
              accessibilityLabel="Estimated cost per task"
              value={draft.cost}
              keyboardType="decimal-pad"
              onChangeText={(cost) => setDraft({ ...draft, cost })}
              editable={!props.disabled}
              className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
            />
            <Text className="font-t3-medium text-foreground">Effort</Text>
          </View>
          {EFFORTS.map((effort) => (
            <SettingsChoiceRow
              key={effort}
              label={effort}
              selected={draft.effort === effort}
              disabled={props.disabled}
              onPress={() => setDraft({ ...draft, effort })}
            />
          ))}
          <Text className="px-4 font-t3-medium text-foreground">
            Task levels · select one or more
          </Text>
          {DelegationCapability.literals.map((capability) => (
            <SettingsSwitchRow
              key={capability}
              icon="checkmark"
              label={TASK_LEVEL_LABELS[capability]}
              value={draft.capabilities.includes(capability)}
              disabled={props.disabled}
              onValueChange={(selected) =>
                setDraft({
                  ...draft,
                  capabilities: selected
                    ? [...draft.capabilities, capability]
                    : draft.capabilities.filter((value) => value !== capability),
                })
              }
            />
          ))}
          <View className="gap-3 px-4">
            {!valid ? (
              <Text className="text-sm text-foreground-muted">
                Enter a valid driver ID, model ID or family pattern, nonnegative cost, and at least
                one task level.
              </Text>
            ) : null}
            <View className="flex-row flex-wrap gap-2">
              <Button
                label="Save route"
                disabled={props.disabled || !valid}
                onPress={() => {
                  if (props.disabled || !valid || !isDelegationModelRoute(candidate)) return;
                  const routes = [...props.routes];
                  if (draft.index === null) routes.push(candidate);
                  else routes[draft.index] = candidate;
                  props.onChange(routes);
                  setDraft(null);
                }}
              />
              <Button label="Cancel" onPress={() => setDraft(null)} />
            </View>
          </View>
        </View>
      )}
    </SettingsSection>
  );
}
