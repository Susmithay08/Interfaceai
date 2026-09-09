import { z } from "zod";
import type { PathTemplate, StepAction, StepAction as StepActionType } from "./action.js";
import type { Condition } from "./condition.js";
import type { TargetDescriptor } from "./target.js";
import type { Transform } from "./transform.js";
import type { AppProfile, OutcomeDefinition } from "./outcome.js";


/* ── scope & targeting ──────────────────────────────────────────────── */

const ScopeSegmentSchema = z.discriminatedUnion("by", [
  z.object({ by: z.literal("name"), value: z.string().min(1) }),
  z.object({ by: z.literal("title"), value: z.string().min(1) }),
  z.object({ by: z.literal("urlPath"), value: z.string().min(1) }),
  z.object({ by: z.literal("index"), value: z.number().int().nonnegative() }),
]);

const ScopePathSchema = z.object({
  path: z.array(ScopeSegmentSchema).max(4),
  region: z.object({ by: z.enum(["landmark", "heading"]), value: z.string() }).optional(),
});

const ValueSourceSchemaForParams = z.discriminatedUnion("from", [
  z.object({ from: z.literal("input"), name: z.string().min(1) }),
  z.object({ from: z.literal("literal"), value: z.string() }),
  z.object({ from: z.literal("output"), name: z.string().min(1) }),
  z.object({ from: z.literal("credential"), ref: z.string().min(1) }),
]);

const TargetStrategySchema = z.object({
  kind: z.enum(["roleAndName", "labelled", "anchoredCell", "roleInRegion", "ordinalInScope"]),
  // A param may be a literal, or a ValueSource bound at run time for parameterized flows
  // (e.g. selecting the result row for the member ID the caller supplied).
  params: z.record(z.union([z.string(), z.number(), ValueSourceSchemaForParams])),
  match: z.enum(["exact", "normalized", "prefix"]).optional(),
});

const TargetDescriptorSchema = z.object({
  scope: ScopePathSchema,
  expectedRole: z.string().min(1),
  primary: TargetStrategySchema,
  fallbacks: z.array(TargetStrategySchema).max(3),
  cardinality: z.enum(["exactlyOne", "nth"]),
  nth: z.number().int().nonnegative().optional(),
  // Required, so every recorded target carries a reviewable justification.
  rationale: z.string().min(10),
});

/* ── matching & conditions (depth capped at 2 by construction) ──────── */

// Bounded to limit catastrophic backtracking on artifact-supplied patterns.
const SAFE_PATTERN_MAX = 200;
const RegexPatternSchema = z.string().min(1).max(SAFE_PATTERN_MAX);

const TextMatcherSchema = z
  .object({
    op: z.enum(["equals", "contains", "startsWith", "regex"]),
    value: z.string().min(1),
    caseSensitive: z.boolean().optional(),
    normalizeWhitespace: z.boolean().optional(),
  })
  .superRefine((m, ctx) => {
    if (m.op === "regex" && m.value.length > SAFE_PATTERN_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `regex pattern exceeds ${SAFE_PATTERN_MAX} characters`,
      });
    }
  });

const LeafConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exists"), target: TargetDescriptorSchema }),
  z.object({ kind: z.literal("absent"), target: TargetDescriptorSchema }),
  z.object({ kind: z.literal("text"), target: TargetDescriptorSchema, match: TextMatcherSchema }),
  z.object({ kind: z.literal("value"), target: TargetDescriptorSchema, match: TextMatcherSchema }),
  z.object({ kind: z.literal("location"), match: TextMatcherSchema }),
]);

const ConditionSchema = z.union([
  LeafConditionSchema,
  z.object({ kind: z.literal("all"), of: z.array(LeafConditionSchema).min(1).max(6) }),
  z.object({ kind: z.literal("any"), of: z.array(LeafConditionSchema).min(1).max(6) }),
]);

/* ── values & actions ───────────────────────────────────────────────── */

const ValueSourceSchema = z.discriminatedUnion("from", [
  z.object({ from: z.literal("input"), name: z.string().min(1) }),
  z.object({ from: z.literal("literal"), value: z.string() }),
  z.object({ from: z.literal("output"), name: z.string().min(1) }),
  z.object({ from: z.literal("credential"), ref: z.string().min(1) }),
]);

const PathTemplateSchema = z.object({
  // Path only. An absolute URL in an artifact would bake in a tenant hostname.
  path: z.string().startsWith("/"),
  params: z.record(ValueSourceSchema).optional(),
});

const StepActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), target: TargetDescriptorSchema }),
  z.object({ kind: z.literal("fill"), target: TargetDescriptorSchema, value: ValueSourceSchema }),
  z.object({ kind: z.literal("select"), target: TargetDescriptorSchema, value: ValueSourceSchema }),
  z.object({
    kind: z.literal("pressKey"),
    key: z.enum(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp"]),
    target: TargetDescriptorSchema.optional(),
  }),
  z.object({
    kind: z.literal("wait"),
    for: ConditionSchema,
    timeoutMs: z.number().int().min(100).max(60000),
    pollMs: z.number().int().min(50).max(2000),
  }),
  z.object({
    kind: z.literal("navigate"),
    path: PathTemplateSchema,
    // Required: navigating by URL is the least portable thing across tenants.
    rationale: z.string().min(10),
  }),
  z.object({ kind: z.literal("dismiss"), target: TargetDescriptorSchema }),
]);

/* ── inputs & outputs ───────────────────────────────────────────────── */

export type Sensitivity = "none" | "identifier" | "pii" | "financial" | "secret";

const SensitivitySchema = z.enum(["none", "identifier", "pii", "financial", "secret"]);

const InputSpecSchema = z.object({
  type: z.enum(["string", "number", "boolean", "enum"]),
  description: z.string().min(1),
  required: z.boolean(),
  pattern: RegexPatternSchema.optional(),
  enum: z.array(z.string()).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  sensitivity: SensitivitySchema,
  // Synthetic only. Doubles as the example in the agent-facing tool schema.
  example: z.string().optional(),
});

const TransformSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("trim") }),
  z.object({ kind: z.literal("normalizeWhitespace") }),
  z.object({ kind: z.literal("stripPrefix"), value: z.string() }),
  z.object({ kind: z.literal("stripSuffix"), value: z.string() }),
  z.object({ kind: z.literal("extractGroup"), pattern: RegexPatternSchema, group: z.number().int() }),
  z.object({ kind: z.literal("currencyToNumber"), currency: z.literal("USD") }),
  z.object({ kind: z.literal("toNumber") }),
  z.object({ kind: z.literal("parseDate"), format: z.enum(["MM/DD/YYYY", "YYYY-MM-DD"]) }),
]);

const OutputSpecSchema = z.object({
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().min(1),
  required: z.boolean(),
  sensitivity: SensitivitySchema,
  source: z.object({
    // Which step's post-action observation to read from.
    from: z.string().min(1),
    target: TargetDescriptorSchema,
    read: z.enum(["text", "value", "name"]),
  }),
  transform: z.array(TransformSchema).max(4),
});

/* ── outcomes ───────────────────────────────────────────────────────── */

const RecoverySchema = z.object({
  actions: z.array(StepActionSchema).min(1).max(5),
  verify: ConditionSchema.optional(),
  resume: z.enum(["retryStep", "continueAfter", "restart"]),
  maxAttempts: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

const OutcomeDefinitionSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/),
    class: z.enum(["business", "recoverable", "hard"]),
    scope: z.union([z.literal("anyStep"), z.object({ steps: z.array(z.string()).min(1) })]),
    detect: ConditionSchema,
    description: z.string().min(10),
    message: z
      .object({
        target: TargetDescriptorSchema,
        read: z.enum(["text", "value"]),
        transform: z.array(TransformSchema).max(2).optional(),
      })
      .optional(),
    recovery: RecoverySchema.optional(),
    escalate: z.boolean().optional(),
  })
  .superRefine((o, ctx) => {
    if (o.class === "recoverable" && !o.recovery) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `outcome "${o.code}": recoverable outcomes must declare a recovery`,
      });
    }
    if (o.class !== "recoverable" && o.recovery) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `outcome "${o.code}": only recoverable outcomes may declare a recovery`,
      });
    }
    if (o.class === "business" && o.escalate === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `outcome "${o.code}": business outcomes are returned to the caller, never escalated`,
      });
    }
  });

export const AppProfileSchema = z.object({
  profile: z.string().min(1),
  outcomes: z.array(OutcomeDefinitionSchema),
});

/* ── steps ──────────────────────────────────────────────────────────── */

const StepSchema = z.object({
  id: z.string().regex(/^s[0-9]+$/),
  // Prose for the human reviewer and for the escalation card.
  intent: z.string().min(5),
  action: StepActionSchema,
  // Explicitly nullable: a step with no checkpoint must be a stated choice.
  checkpoint: ConditionSchema.nullable(),
  checkpointOmittedReason: z.string().optional(),
  robustness: z.enum(["strong", "weak"]),
  robustnessNote: z.string().optional(),
  provenance: z.enum(["llm", "human", "reviewer"]),
});

/* ── the capability ─────────────────────────────────────────────────── */

const CapabilityBase = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().regex(/^[a-z0-9]+(\.[a-zA-Z0-9]+)+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  title: z.string().min(5),
  description: z.string().min(20),

  app: z.object({
    product: z.string().min(1),
    productVersion: z.string().min(1),
    variant: z.string().min(1),
    entry: PathTemplateSchema,
  }),
  entryCheckpoint: ConditionSchema,

  status: z.enum(["draft", "in_review", "approved", "deprecated"]),
  risk: z.enum(["readOnly", "reversible", "irreversible"]),

  inputs: z.record(InputSpecSchema),
  outputs: z.record(OutputSpecSchema),

  preconditions: z.array(ConditionSchema).max(4),
  steps: z.array(StepSchema).min(1).max(30),
  successCheckpoint: ConditionSchema,

  inheritsOutcomesFrom: z.string().optional(),
  outcomes: z.array(OutcomeDefinitionSchema),

  escalation: z.object({
    onHardFailure: z.enum(["escalate", "fail"]),
    onUnresolvedTarget: z.enum(["escalate", "fail"]),
    onAmbiguousTarget: z.enum(["escalate", "fail"]),
    onUnknownState: z.enum(["escalate", "fail"]),
    operatorTimeoutSeconds: z.number().int().min(5).max(3600),
  }),

  provenance: z.object({
    generatedBy: z.enum(["llm-discovery", "human-authored"]),
    discoveredAt: z.string(),
    runId: z.string(),
    provider: z.string(),
    model: z.string(),
    // A path into /evidence. Never embedded observation or screenshot data.
    evidenceRunRef: z.string(),
    goal: z.string(),
    llmStepCount: z.number().int().nonnegative(),
    humanStepCount: z.number().int().nonnegative(),
  }),

  review: z.object({
    reviewedBy: z.string().optional(),
    reviewedAt: z.string().optional(),
    notes: z.string().optional(),
    weakTargets: z.array(z.string()),
  }),
});

type CapabilityShape = z.infer<typeof CapabilityBase>;

/**
 * Mirrors policy/risk.ts classifyAction. model/ stays dependency-free by design,
 * so the rule is duplicated here; a test in tests/unit/policy asserts the two agree.
 */
const MUTATING = /\b(transfer|post|delete|remove|approve|authorize|confirm|withdraw|disburse)\b/i;

function localRisk(a: StepActionType): "readOnly" | "reversible" | "irreversible" {
  switch (a.kind) {
    case "wait":
    case "pressKey":
    case "navigate":
    case "dismiss":
      return "readOnly";
    case "fill":
    case "select":
      return "reversible";
    case "click":
      return MUTATING.test(`${a.target.rationale} ${JSON.stringify(a.target.primary.params)}`)
        ? "irreversible"
        : "readOnly";
  }
}

/**
 * Cross-field checks that decide whether this artifact can actually be replayed.
 * An artifact failing these must not load: far better to fail at parse than to
 * fail halfway through a run against a live banking screen.
 */
function assertReplayable(c: CapabilityShape, ctx: z.RefinementCtx): void {
  const stepIds = new Set(c.steps.map((s) => s.id));
  const inputNames = new Set(Object.keys(c.inputs));
  const outputNames = new Set(Object.keys(c.outputs));
  const issue = (message: string, path: (string | number)[]): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  };

  c.steps.forEach((s, i) => {
    if (s.checkpoint === null && !s.checkpointOmittedReason) {
      issue(`step ${s.id} omits its checkpoint without stating a reason`, ["steps", i]);
    }
    const action = s.action;
    if (action.kind === "fill" || action.kind === "select") {
      const v = action.value;
      if (v.from === "input" && !inputNames.has(v.name)) {
        issue(`step ${s.id} references undeclared input "${v.name}"`, ["steps", i]);
      }
      if (v.from === "output" && !outputNames.has(v.name)) {
        issue(`step ${s.id} references undeclared output "${v.name}"`, ["steps", i]);
      }
      if (v.from === "literal") {
        for (const [name, spec] of Object.entries(c.inputs)) {
          if (spec.sensitivity !== "none" && v.value === spec.example) {
            issue(
              `step ${s.id} binds a literal matching sensitive input "${name}" - use {from:"input"}`,
              ["steps", i],
            );
          }
        }
      }
    }
  });

  Object.entries(c.outputs).forEach(([name, o]) => {
    if (!stepIds.has(o.source.from)) {
      issue(`output "${name}" reads from unknown step "${o.source.from}"`, ["outputs", name]);
    }
  });

  const seen = new Set<string>();
  c.outcomes.forEach((o, i) => {
    if (seen.has(o.code)) issue(`duplicate outcome code "${o.code}"`, ["outcomes", i]);
    seen.add(o.code);
    if (typeof o.scope === "object") {
      for (const id of o.scope.steps) {
        if (!stepIds.has(id)) {
          issue(`outcome "${o.code}" is scoped to unknown step "${id}"`, ["outcomes", i]);
        }
      }
    }
    for (const a of o.recovery?.actions ?? []) {
      if (localRisk(a as StepActionType) === "irreversible") {
        issue(`outcome "${o.code}" recovery contains an irreversible action`, ["outcomes", i]);
      }
    }
  });
}

export const CapabilitySchema = CapabilityBase.superRefine(assertReplayable);

/*
 * The hand-written types below are authoritative; Zod is the runtime validator.
 *
 * Inferring the types from the schema instead would produce a second, mutable copy of
 * the model that drifts from the readonly types in model/, and the two would silently
 * disagree at every boundary. The schema contains no defaults or transforms, so a value
 * that validates is structurally identical to what was parsed.
 */

export interface InputSpec {
  readonly type: "string" | "number" | "boolean" | "enum";
  readonly description: string;
  readonly required: boolean;
  readonly pattern?: string;
  readonly enum?: readonly string[];
  readonly default?: string | number | boolean;
  readonly sensitivity: Sensitivity;
  readonly example?: string;
}

export interface OutputSpec {
  readonly type: "string" | "number" | "boolean";
  readonly description: string;
  readonly required: boolean;
  readonly sensitivity: Sensitivity;
  readonly source: {
    readonly from: string;
    readonly target: TargetDescriptor;
    readonly read: "text" | "value" | "name";
  };
  readonly transform: readonly Transform[];
}

export interface Step {
  readonly id: string;
  readonly intent: string;
  readonly action: StepAction;
  readonly checkpoint: Condition | null;
  readonly checkpointOmittedReason?: string;
  readonly robustness: "strong" | "weak";
  readonly robustnessNote?: string;
  readonly provenance: "llm" | "human" | "reviewer";
}

export interface Capability {
  readonly schemaVersion: "1.0";
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly app: {
    readonly product: string;
    readonly productVersion: string;
    readonly variant: string;
    readonly entry: PathTemplate;
  };
  readonly entryCheckpoint: Condition;
  readonly status: "draft" | "in_review" | "approved" | "deprecated";
  readonly risk: "readOnly" | "reversible" | "irreversible";
  readonly inputs: Readonly<Record<string, InputSpec>>;
  readonly outputs: Readonly<Record<string, OutputSpec>>;
  readonly preconditions: readonly Condition[];
  readonly steps: readonly Step[];
  readonly successCheckpoint: Condition;
  readonly inheritsOutcomesFrom?: string;
  readonly outcomes: readonly OutcomeDefinition[];
  readonly escalation: {
    readonly onHardFailure: "escalate" | "fail";
    readonly onUnresolvedTarget: "escalate" | "fail";
    readonly onAmbiguousTarget: "escalate" | "fail";
    readonly onUnknownState: "escalate" | "fail";
    readonly operatorTimeoutSeconds: number;
  };
  readonly provenance: {
    readonly generatedBy: "llm-discovery" | "human-authored";
    readonly discoveredAt: string;
    readonly runId: string;
    readonly provider: string;
    readonly model: string;
    readonly evidenceRunRef: string;
    readonly goal: string;
    readonly llmStepCount: number;
    readonly humanStepCount: number;
  };
  readonly review: {
    readonly reviewedBy?: string;
    readonly reviewedAt?: string;
    readonly notes?: string;
    readonly weakTargets: readonly string[];
  };
}

export type { OutcomeDefinition, AppProfile, Recovery } from "./outcome.js";


export class CapabilityValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super(
      "capability failed validation:\n" +
        issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n"),
    );
    this.name = "CapabilityValidationError";
  }
}

export function parseCapability(json: unknown): Capability {
  const r = CapabilitySchema.safeParse(json);
  if (!r.success) throw new CapabilityValidationError(r.error.issues);
  return r.data as Capability;
}

export function parseAppProfile(json: unknown): AppProfile {
  const r = AppProfileSchema.safeParse(json);
  if (!r.success) throw new CapabilityValidationError(r.error.issues);
  return r.data as AppProfile;
}
