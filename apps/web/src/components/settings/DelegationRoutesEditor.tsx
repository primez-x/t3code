import { useRef, useState } from "react";
import {
  delegationCreditsOverride,
  DelegationModelRoute,
  ProviderInstanceId,
  type DelegationPolicyPatch,
  type EnvironmentId,
  type DelegationCapability,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const PRIORITIES = {
  usage: "Available quota",
  cost: "Lowest estimated cost",
  provider: "Preferred provider",
} as const;
const TASK_LABELS: Record<DelegationCapability, string> = {
  lookup: "Exact facts",
  discovery: "Research",
  mechanical: "Simple edits",
  routine: "Small implementations",
  coding: "Code and workflows",
  substantial: "Large implementations",
  architecture: "Design, advice, and review",
};
const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const EFFORT_LABELS = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high" } as const;
const isRoute = Schema.is(DelegationModelRoute);
const isProviderInstanceId = Schema.is(ProviderInstanceId);

export function DelegationRoutingSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const saveEnvironmentSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save delegation settings",
  });
  const [saving, setSaving] = useState(false);
  const saveInProgress = useRef(false);
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  const writable = useScopedSettingsWriteAllowed();
  const policy = settings.delegationPolicy;
  const singleEnvironment =
    scope.environmentIds.length === 1 && environment !== null && environment !== undefined;
  const editable =
    singleEnvironment && writable && scope.kind !== "project" && scope.kind !== "checkout";
  const providers = sortProviderInstanceEntries(
    deriveProviderInstanceEntries(environment?.serverConfig?.providers ?? []),
  );
  const mixed = (key: keyof typeof policy) =>
    connectedEnvironments.some(
      (candidate) => candidate.serverConfig?.settings.delegationPolicy[key] !== policy[key],
    );
  const [routesEnvironmentId, setRoutesEnvironmentId] = useState<EnvironmentId | null>(null);
  const routesOpen =
    routesEnvironmentId !== null && routesEnvironmentId === environment?.environmentId;
  const preferred = providers.find(
    (provider) => provider.instanceId === policy.preferredProviderInstanceId,
  );
  const creditProviderIds = [
    ...new Set([
      ...providers.map((provider) => provider.instanceId),
      ...Object.keys(policy.allowCreditsByProvider).filter(isProviderInstanceId),
    ]),
  ];

  const saveInstancePolicy = async (patch: DelegationPolicyPatch) => {
    if (!editable || !environment || saveInProgress.current) return false;
    saveInProgress.current = true;
    setSaving(true);
    try {
      const result = await saveEnvironmentSettings({
        environmentId: environment.environmentId,
        input: { patch: { delegationPolicy: patch } },
      });
      return result._tag === "Success";
    } finally {
      saveInProgress.current = false;
      setSaving(false);
    }
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("delegation-routing-priority")}
        serverScoped
        settingKeys={["delegationPolicy"]}
        mixed={mixed("routingPriority")}
        description="Rank capable choices by available subscription quota, estimated cost, or provider preference. Capability and advisor requirements always apply."
        control={
          <Select
            value={policy.routingPriority}
            onValueChange={(routingPriority) => {
              if (
                routingPriority === "usage" ||
                routingPriority === "cost" ||
                routingPriority === "provider"
              )
                updateSettings({ delegationPolicy: { routingPriority } });
            }}
          >
            <SelectTrigger size="sm" aria-label="Delegation routing priority">
              <SelectValue>
                {mixed("routingPriority") ? "Mixed" : PRIORITIES[policy.routingPriority]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(PRIORITIES).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("delegation-preferred-provider")}
        serverScoped
        settingKeys={["delegationPolicy"]}
        mixed={false}
        description={
          singleEnvironment
            ? "Use this provider for Preferred provider priority. Parent provider follows the provider of the agent that delegates."
            : "Select one environment to change the preferred provider. Provider choices belong to each environment."
        }
        control={
          <Select
            disabled={!editable || saving}
            value={policy.preferredProviderInstanceId ?? "__parent__"}
            onValueChange={(value) => {
              if (!editable || saveInProgress.current) return;
              const provider = providers.find((candidate) => candidate.instanceId === value);
              if (value === "__parent__" || provider)
                void saveInstancePolicy({
                  preferredProviderInstanceId: provider?.instanceId ?? null,
                });
            }}
          >
            <SelectTrigger size="sm" aria-label="Preferred delegation provider">
              <SelectValue>
                {singleEnvironment
                  ? (preferred?.displayName ??
                    (policy.preferredProviderInstanceId
                      ? `${policy.preferredProviderInstanceId} (unavailable)`
                      : "Parent provider"))
                  : "Select one environment"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="__parent__">Parent provider</SelectItem>
              {policy.preferredProviderInstanceId && !preferred ? (
                <SelectItem value={policy.preferredProviderInstanceId}>
                  {policy.preferredProviderInstanceId} (unavailable)
                </SelectItem>
              ) : null}
              {providers.map((provider) => (
                <SelectItem key={provider.instanceId} value={provider.instanceId}>
                  {provider.displayName}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("delegation-fallback")}
        serverScoped
        settingKeys={["delegationPolicy"]}
        mixed={mixed("allowFallback")}
        description="Allow a capable substitute when a requested provider or model is unavailable. Off reports the unavailable target without a substitute."
        control={
          <Switch
            mixed={mixed("allowFallback")}
            checked={!mixed("allowFallback") && policy.allowFallback}
            aria-label="Requested target fallback"
            onCheckedChange={(allowFallback) =>
              updateSettings({ delegationPolicy: { allowFallback } })
            }
          />
        }
      />
      <SettingsRow
        {...searchableSetting("delegation-quota-reserve")}
        serverScoped
        settingKeys={["delegationPolicy"]}
        mixed={mixed("minimumHeadroomPercent")}
        description="Skip providers at or below this subscription percentage. Above zero, unknown quota is excluded. Zero disables the reserve. Allowed paid usage remains eligible after quota exhaustion; the reserve cannot force early paid usage."
        control={
          <div className="w-28">
            <NumberField
              size="sm"
              min={0}
              max={100}
              step={1}
              value={mixed("minimumHeadroomPercent") ? null : policy.minimumHeadroomPercent}
              onValueChange={(minimumHeadroomPercent) => {
                if (
                  minimumHeadroomPercent !== null &&
                  Number.isFinite(minimumHeadroomPercent) &&
                  minimumHeadroomPercent >= 0 &&
                  minimumHeadroomPercent <= 100
                )
                  updateSettings({ delegationPolicy: { minimumHeadroomPercent } });
              }}
            >
              <NumberFieldGroup>
                <NumberFieldInput
                  aria-label="Subscription quota reserve percentage"
                  placeholder={mixed("minimumHeadroomPercent") ? "Mixed" : undefined}
                />
              </NumberFieldGroup>
            </NumberField>
          </div>
        }
      />
      <SettingsRow
        {...searchableSetting("delegation-provider-credits")}
        serverScoped
        settingKeys={["delegationPolicy"]}
        mixed={false}
        description={
          singleEnvironment
            ? "Override Allow credits for each provider. Paid usage starts only after subscription quota runs out."
            : "Select one environment to change provider credit overrides. Provider choices belong to each environment."
        }
        control={
          <div className="space-y-2">
            {singleEnvironment && creditProviderIds.length > 0 ? (
              creditProviderIds.map((id) => {
                const provider = providers.find((candidate) => candidate.instanceId === id);
                const override = delegationCreditsOverride(policy, id);
                return (
                  <div key={id} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs">
                      {provider?.displayName ?? `${id} (unavailable)`}
                    </span>
                    <Select
                      disabled={!editable || saving}
                      value={override === undefined ? "global" : override ? "allow" : "deny"}
                      onValueChange={(value) => {
                        if (
                          !editable ||
                          saveInProgress.current ||
                          (value !== "global" && value !== "allow" && value !== "deny")
                        )
                          return;
                        const allowCreditsByProvider = { ...policy.allowCreditsByProvider };
                        if (value === "global") delete allowCreditsByProvider[id];
                        else allowCreditsByProvider[id] = value === "allow";
                        void saveInstancePolicy({ allowCreditsByProvider });
                      }}
                    >
                      <SelectTrigger
                        size="sm"
                        aria-label={`${provider?.displayName ?? id} credits`}
                      >
                        <SelectValue>
                          {override === undefined
                            ? "Use global"
                            : override
                              ? "Allow"
                              : "Do not allow"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="end" alignItemWithTrigger={false}>
                        <SelectItem value="global">Use global</SelectItem>
                        <SelectItem value="allow">Allow</SelectItem>
                        <SelectItem value="deny">Do not allow</SelectItem>
                      </SelectPopup>
                    </Select>
                  </div>
                );
              })
            ) : (
              <span className="text-xs text-muted-foreground">
                {singleEnvironment ? "No configured providers" : "Select one environment"}
              </span>
            )}
          </div>
        }
      />
      <SettingsRow
        {...searchableSetting("delegation-routes")}
        serverScoped
        settingKeys={["delegationPolicy"]}
        mixed={false}
        description={
          singleEnvironment
            ? "Set model or family routes, effort, supported tasks, and estimated cost. Capability and advisor requirements always apply."
            : "Select one environment to view and edit model routes."
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!editable || saving}
            onClick={() => {
              if (environment) setRoutesEnvironmentId(environment.environmentId);
            }}
          >
            Edit routes{singleEnvironment ? ` (${policy.routes.length})` : ""}
          </Button>
        }
      />
      <Dialog
        open={routesOpen && editable}
        onOpenChange={(open) => {
          if (!saveInProgress.current)
            setRoutesEnvironmentId(open ? (environment?.environmentId ?? null) : null);
        }}
      >
        <DialogPopup showCloseButton={!saving}>
          <DialogHeader>
            <DialogTitle>Model routes</DialogTitle>
            <DialogDescription>
              Configure models for supported tasks. Routes do not override capability or advisor
              requirements.
            </DialogDescription>
          </DialogHeader>
          {routesOpen && editable ? (
            <DelegationRoutesEditor
              key={`${environment?.environmentId}:${JSON.stringify(policy.routes)}`}
              saving={saving}
              routes={policy.routes}
              drivers={providers.map((provider) => provider.driverKind)}
              onCancel={() => setRoutesEnvironmentId(null)}
              onSave={(routes) => {
                if (!editable || saveInProgress.current) return;
                void saveInstancePolicy({ routes }).then((saved) => {
                  if (saved) setRoutesEnvironmentId(null);
                });
              }}
            />
          ) : null}
        </DialogPopup>
      </Dialog>
    </>
  );
}

type RouteDraft = Omit<DelegationModelRoute, "costPerTask"> & { costPerTask: string; key: number };

function DelegationRoutesEditor({
  saving,
  routes,
  drivers,
  onSave,
  onCancel,
}: {
  saving: boolean;
  routes: readonly DelegationModelRoute[];
  drivers: readonly ProviderDriverKind[];
  onSave: (routes: DelegationModelRoute[]) => void;
  onCancel: () => void;
}) {
  const [drafts, setDrafts] = useState<RouteDraft[]>(() =>
    routes.map((route, key) => ({ ...route, costPerTask: String(route.costPerTask), key })),
  );
  const [nextKey, setNextKey] = useState(routes.length);
  const driverChoices = [...new Set([...drivers, ...routes.map((route) => route.driver)])];
  const update = (key: number, patch: Partial<RouteDraft>) =>
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)),
    );
  const validRoutes = drafts.map(({ key: _key, ...draft }) => ({
    ...draft,
    model: draft.model.trim(),
    costPerTask: Number(draft.costPerTask),
  }));
  const valid = drafts.every(
    (draft, index) =>
      draft.costPerTask.trim() !== "" &&
      draft.capabilities.length > 0 &&
      !/\s/.test(draft.model.trim()) &&
      (!draft.model.includes("*") || /^[^*]+-\*$/.test(draft.model.trim())) &&
      isRoute(validRoutes[index]),
  );

  return (
    <>
      <DialogPanel>
        <fieldset disabled={saving} className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Custom routes replace the default route list. Remove every route to restore defaults.
            Use an exact model ID or a family such as gpt-6-*. Select only tasks the model supports.
            Cost is an estimate for comparison, not an actual charge or spend limit.
          </p>
          {drafts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No custom routes. Default routing applies.
            </p>
          ) : null}
          {drafts.map((draft, index) => (
            <Collapsible key={draft.key} defaultOpen={draft.key >= routes.length}>
              <div className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <p className="break-all text-sm font-medium">
                      {draft.driver} · {draft.model || "New route"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {EFFORT_LABELS[draft.effort]} effort · {draft.costPerTask || "—"} estimated
                      cost per task
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {draft.capabilities.map((capability) => TASK_LABELS[capability]).join(", ") ||
                        "Select supported tasks"}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <CollapsibleTrigger
                      render={
                        <Button size="sm" variant="ghost" aria-label={`Edit route ${index + 1}`} />
                      }
                    >
                      Edit
                    </CollapsibleTrigger>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove route ${index + 1}`}
                      onClick={() =>
                        setDrafts((current) => current.filter((route) => route.key !== draft.key))
                      }
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                <CollapsiblePanel animate={false}>
                  <fieldset className="mt-3 space-y-3">
                    <legend className="sr-only">Route {index + 1}</legend>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="space-y-1 text-xs">
                        <span>Provider</span>
                        <Select
                          value={draft.driver}
                          onValueChange={(value) => {
                            const driver = driverChoices.find((candidate) => candidate === value);
                            if (driver) update(draft.key, { driver });
                          }}
                        >
                          <SelectTrigger size="sm" aria-label={`Route ${index + 1} provider`}>
                            <SelectValue>{draft.driver || "Select provider"}</SelectValue>
                          </SelectTrigger>
                          <SelectPopup>
                            {driverChoices.map((driver) => (
                              <SelectItem key={driver} value={driver}>
                                {driver}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </label>
                      <label className="space-y-1 text-xs">
                        <span>Model ID or family</span>
                        <Input
                          value={draft.model}
                          placeholder="gpt-6-*"
                          onChange={(event) => update(draft.key, { model: event.target.value })}
                        />
                      </label>
                      <label className="space-y-1 text-xs">
                        <span>Effort</span>
                        <Select
                          value={draft.effort}
                          onValueChange={(value) => {
                            const effort = EFFORTS.find((candidate) => candidate === value);
                            if (effort) update(draft.key, { effort });
                          }}
                        >
                          <SelectTrigger size="sm" aria-label={`Route ${index + 1} effort`}>
                            <SelectValue>{EFFORT_LABELS[draft.effort]}</SelectValue>
                          </SelectTrigger>
                          <SelectPopup>
                            {EFFORTS.map((effort) => (
                              <SelectItem key={effort} value={effort}>
                                {EFFORT_LABELS[effort]}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </label>
                      <label className="space-y-1 text-xs">
                        <span>Estimated cost per task</span>
                        <Input
                          type="number"
                          min={0}
                          step="any"
                          value={draft.costPerTask}
                          onChange={(event) =>
                            update(draft.key, { costPerTask: event.target.value })
                          }
                        />
                      </label>
                    </div>
                    <fieldset className="space-y-2">
                      <legend className="mb-1 text-xs">Supported tasks</legend>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {Object.entries(TASK_LABELS).map(([capability, label]) => (
                          <label key={capability} className="flex items-center gap-2 text-xs">
                            <Checkbox
                              checked={draft.capabilities.some((value) => value === capability)}
                              onCheckedChange={(checked) => {
                                const selected = Object.keys(TASK_LABELS).filter(
                                  (value): value is DelegationCapability =>
                                    value === capability ||
                                    draft.capabilities.some((current) => current === value),
                                );
                                update(draft.key, {
                                  capabilities: checked
                                    ? selected
                                    : draft.capabilities.filter((value) => value !== capability),
                                });
                              }}
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  </fieldset>
                </CollapsiblePanel>
              </div>
            </Collapsible>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={driverChoices.length === 0}
            onClick={() => {
              const driver = driverChoices[0];
              if (!driver) return;
              setDrafts((current) => [
                ...current,
                {
                  key: nextKey,
                  driver,
                  model: "",
                  effort: "medium",
                  capabilities: [],
                  costPerTask: "",
                },
              ]);
              setNextKey((current) => current + 1);
            }}
          >
            Add route
          </Button>
          {driverChoices.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Configure a provider before adding a route.
            </p>
          ) : null}
          {!valid ? (
            <p role="status" className="text-xs text-destructive">
              Complete every route: model ID or family, supported tasks, and a finite cost of zero
              or more.
            </p>
          ) : null}
        </fieldset>
      </DialogPanel>
      <DialogFooter>
        <Button size="sm" variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!valid || saving}
          onClick={() => {
            if (valid && !saving) onSave(validRoutes);
          }}
        >
          {saving ? "Save in progress…" : "Save routes"}
        </Button>
      </DialogFooter>
    </>
  );
}
