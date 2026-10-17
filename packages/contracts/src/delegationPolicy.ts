import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const DelegationMode = Schema.Literals(["native-preferred", "t3-managed"]);
export type DelegationMode = typeof DelegationMode.Type;

export const DelegationRoutingPriority = Schema.Literals(["usage", "cost", "provider"]);
export type DelegationRoutingPriority = typeof DelegationRoutingPriority.Type;

const MinimumHeadroomPercent = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: 0, maximum: 100 }),
);

export const DelegationCapability = Schema.Literals([
  "lookup",
  "discovery",
  "mechanical",
  "routine",
  "coding",
  "substantial",
  "architecture",
]).annotate({
  description:
    "Required task floor. lookup: exact fact. discovery: bounded research or classification. mechanical: a decided edit with a deterministic check. routine: bounded implementation. coding: terminal code or workflow work. substantial: larger implementation. architecture: difficult diagnosis, design, advice, or independent review. Mechanical and routine tasks can use capable Haiku routes. Advice and review always require architecture. Defaults: research discovery; implementation/test coding; design/advice/review architecture; general routine.",
});
export type DelegationCapability = typeof DelegationCapability.Type;

export const DelegationTaskRole = Schema.Literals([
  "implementation",
  "research",
  "review",
  "design",
  "test",
  "general",
  "advice",
]);
export type DelegationTaskRole = typeof DelegationTaskRole.Type;

export const DelegationModelRoute = Schema.Struct({
  driver: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  effort: Schema.Literals(["low", "medium", "high", "xhigh"]),
  capabilities: Schema.Array(DelegationCapability),
  costPerTask: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
});
export type DelegationModelRoute = typeof DelegationModelRoute.Type;

export const DelegationPolicy = Schema.Struct({
  version: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  mode: DelegationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("native-preferred" as const)),
  ),
  allowCredits: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  routingPriority: DelegationRoutingPriority.pipe(
    Schema.withDecodingDefault(Effect.succeed("usage" as const)),
  ),
  preferredProviderInstanceId: Schema.NullOr(ProviderInstanceId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  allowFallback: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  minimumHeadroomPercent: MinimumHeadroomPercent.pipe(
    Schema.withDecodingDefault(Effect.succeed(0)),
  ),
  allowCreditsByProvider: Schema.Record(ProviderInstanceId, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  preferAlternateProvider: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  routes: Schema.Array(DelegationModelRoute).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type DelegationPolicy = typeof DelegationPolicy.Type;

export const DelegationPolicyPatch = Schema.Struct({
  version: Schema.optionalKey(Schema.Literal(1)),
  mode: Schema.optionalKey(DelegationMode),
  allowCredits: Schema.optionalKey(Schema.Boolean),
  routingPriority: Schema.optionalKey(DelegationRoutingPriority),
  preferredProviderInstanceId: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
  allowFallback: Schema.optionalKey(Schema.Boolean),
  minimumHeadroomPercent: Schema.optionalKey(MinimumHeadroomPercent),
  allowCreditsByProvider: Schema.optionalKey(Schema.Record(ProviderInstanceId, Schema.Boolean)),
  preferAlternateProvider: Schema.optionalKey(Schema.Boolean),
  routes: Schema.optionalKey(Schema.Array(DelegationModelRoute)),
});
export type DelegationPolicyPatch = typeof DelegationPolicyPatch.Type;

export const DelegationRoutingDecision = Schema.Struct({
  policyVersion: Schema.Literal(1),
  capability: DelegationCapability,
  role: DelegationTaskRole,
  reason: Schema.Literals([
    "explicit-target",
    "advisor-fable",
    "advisor-opus",
    "advisor-fallback",
    "headroom",
    "alternate-provider",
    "alternate-model",
    "lowest-cost",
    "preferred-provider",
  ]),
  headroomPercent: Schema.NullOr(Schema.Number),
  usesCredits: Schema.optional(Schema.Boolean),
  usageCheckedAt: Schema.NullOr(IsoDateTime),
  substitution: Schema.optional(
    Schema.Struct({
      requestedModel: Schema.optional(TrimmedNonEmptyString),
      requestedProviderInstanceId: Schema.optional(ProviderInstanceId),
      requestedDriver: Schema.optional(ProviderDriverKind),
      reason: TrimmedNonEmptyString,
    }),
  ),
});
export type DelegationRoutingDecision = typeof DelegationRoutingDecision.Type;
