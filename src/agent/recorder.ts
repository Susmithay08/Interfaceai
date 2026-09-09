import type { Observation, ScopePath, UiNode } from "../model/observation.js";
import type { Ref } from "../model/ids.js";
import type {
  TargetDescriptor,
  TargetParam,
  TargetStrategy,
} from "../model/target.js";
import type { Capability, Step } from "../model/capability.js";
import type { Condition } from "../model/condition.js";
import type { StepAction } from "../model/action.js";
import type { Transform } from "../model/transform.js";
import { resolveTarget } from "../resolution/resolve-target.js";
import { bindTarget } from "../resolution/bind.js";
import { maxRisk } from "../policy/risk.js";

/** Input name -> the concrete value used during discovery. */
export type VolatileValues = Readonly<Record<string, string>>;

interface Candidate {
  readonly strategy: TargetStrategy;
  readonly scope: ScopePath;
  readonly weak: boolean;
  readonly why: string;
}


/**
 * Replaces a param that exactly equals a supplied input value with a reference to that
 * input, so the recorded target is parameterized rather than pinned to the discovery
 * run's data. This is what lets one recording serve every member ID.
 */
function parameterize(value: string, volatile: VolatileValues): TargetParam {
  for (const [name, v] of Object.entries(volatile)) {
    if (v === value) return { from: "input", name };
  }
  return value;
}

/** True if the text merely CONTAINS run-specific data - such a candidate is unusable. */
function isDataDependent(value: string, volatile: VolatileValues): boolean {
  return Object.values(volatile).some((v) => v.length > 0 && value !== v && value.includes(v));
}

function scopeOf(node: UiNode, volatile: VolatileValues, withRegion: boolean): ScopePath {
  if (!withRegion || !node.scope.region) return { path: node.scope.path };
  // A region derived from a heading like "Member: Dana Whitfield" is data-dependent and
  // must not be recorded: it would pin the capability to one member.
  if (isDataDependent(node.scope.region.value, volatile)) return { path: node.scope.path };
  return { path: node.scope.path, region: node.scope.region };
}

const anchorsOf = (n: UiNode, kind: string): string[] =>
  n.anchors.filter((a) => a.kind === kind).map((a) => a.text);

/** Candidate strategies, best first. Each is only offered if the node carries the metadata. */
function candidatesFor(node: UiNode, volatile: VolatileValues): Candidate[] {
  const out: Candidate[] = [];
  const scoped = scopeOf(node, volatile, true);
  const unscoped = scopeOf(node, volatile, false);

  const rowKeys = anchorsOf(node, "rowHeader");
  const colHeaders = anchorsOf(node, "columnHeader");
  if (rowKeys.length > 0 && colHeaders.length > 0) {
    const rowKey = rowKeys[0]!;
    const columnHeader = colHeaders[0]!;
    if (!isDataDependent(rowKey, volatile) && !isDataDependent(columnHeader, volatile)) {
      out.push({
        strategy: {
          kind: "anchoredCell",
          params: {
            rowKey: parameterize(rowKey, volatile),
            columnHeader: parameterize(columnHeader, volatile),
          },
        },
        scope: scoped,
        weak: false,
        why: "row-key by column-header anchoring, which survives column reordering and added columns on a table with no ids",
      });
    }
  }

  for (const label of anchorsOf(node, "label")) {
    if (isDataDependent(label, volatile)) continue;
    out.push({
      strategy: { kind: "labelled", params: { label: parameterize(label, volatile) } },
      scope: unscoped,
      weak: false,
      why: "an explicit label association, the most stable identifier available on a form with no test ids",
    });
  }

  if (node.name && !isDataDependent(node.name, volatile)) {
    out.push({
      strategy: {
        kind: "roleAndName",
        params: { role: node.role, name: parameterize(node.name, volatile) },
      },
      scope: unscoped,
      weak: false,
      why: "role plus accessible name, which is stable across this product's versions",
    });
    out.push({
      strategy: {
        kind: "roleAndName",
        params: { role: node.role, name: parameterize(node.name, volatile) },
      },
      scope: scoped,
      weak: false,
      why: "role plus accessible name, narrowed to its region to disambiguate",
    });
  }

  if (node.scope.region && !isDataDependent(node.scope.region.value, volatile)) {
    out.push({
      strategy: {
        kind: "roleInRegion",
        params: { region: node.scope.region.value, role: node.role },
      },
      scope: unscoped,
      weak: false,
      why: "the only control of its role within a named region",
    });
  }

  // Last resort. Recorded, but flagged so a reviewer sees the risk before production does.
  const siblings = 0;
  out.push({
    strategy: { kind: "ordinalInScope", params: { role: node.role, index: siblings } },
    scope: scoped,
    weak: true,
    why: "positional fallback - no label, name, or anchor was available, so this target is weak and should be reviewed",
  });

  return out;
}

/**
 * Turns a ref the model pointed at into a durable, parameterized TargetDescriptor.
 *
 * Every candidate is SELF-VALIDATED: it is run back through resolveTarget against the
 * very observation it was derived from, and kept only if it resolves uniquely to the
 * same node. A descriptor that could not replay is never recorded, so discovery cannot
 * hand replay something that will not work.
 */
export function describeTarget(
  ref: Ref,
  observation: Observation,
  volatile: VolatileValues = {},
): TargetDescriptor | null {
  const node = observation.nodes.find((n) => n.ref === ref);
  if (!node) return null;

  const bindCtx = {
    inputs: volatile,
    outputs: {},
    credentials: () => undefined,
  };

  const survivors: Candidate[] = [];
  for (const candidate of candidatesFor(node, volatile)) {
    const probe: TargetDescriptor = {
      scope: candidate.scope,
      expectedRole: node.role,
      primary: candidate.strategy,
      fallbacks: [],
      cardinality: "exactlyOne",
      rationale: "probe",
    };
    const bound = bindTarget(probe, bindCtx);
    if (!bound.ok) continue;

    const resolution = resolveTarget(bound.target, observation);
    if (resolution.ok && resolution.ref === ref) survivors.push(candidate);
  }

  if (survivors.length === 0) return null;

  const primary = survivors[0]!;
  const fallbacks = survivors
    .slice(1, 4)
    .filter((c) => JSON.stringify(c.strategy) !== JSON.stringify(primary.strategy));

  const surfaceNote =
    "This surface has no test ids and uses table-based layout, so structural selectors are not viable.";

  return {
    scope: primary.scope,
    expectedRole: node.role,
    primary: primary.strategy,
    fallbacks: fallbacks.map((f) => f.strategy),
    cardinality: "exactlyOne",
    rationale: `Identified by ${primary.why}. ${surfaceNote}${
      fallbacks.length > 0 ? ` ${fallbacks.length} verified fallback(s) recorded.` : ""
    }`,
  };
}

export const isWeak = (t: TargetDescriptor): boolean => t.primary.kind === "ordinalInScope";

/* ── finalization ─────────────────────────────────────────────────────── */

export interface RecordedStep {
  readonly action: StepAction;
  readonly rationale: string;
  readonly provenance: "llm" | "human";
}

export interface RecordedOutput {
  readonly field: string;
  readonly as: "string" | "number";
  readonly target: TargetDescriptor;
  readonly sampleValue: string;
  readonly afterStepId: string;
}

export interface FinalizeArgs {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly goal: string;
  readonly entryPath: string;
  readonly entryCheckpoint: Condition;
  readonly inputs: Capability["inputs"];
  readonly steps: readonly RecordedStep[];
  readonly outputs: readonly RecordedOutput[];
  readonly successCheckpoint: Condition;
  readonly provider: string;
  readonly model: string;
  readonly runId: string;
  readonly evidenceRunRef: string;
  readonly product?: string;
  readonly productVersion?: string;
  readonly inheritsOutcomesFrom?: string;
}

const MONEY = /^\s*\$/;

/** Heuristic only. The human confirms sensitivity at review; the schema records their call. */
function guessSensitivity(field: string): Capability["outputs"][string]["sensitivity"] {
  if (/balance|amount|payment|total/i.test(field)) return "financial";
  if (/name|address|email|phone/i.test(field)) return "pii";
  if (/id$|number|account/i.test(field)) return "identifier";
  return "none";
}

function transformsFor(as: "string" | "number", sample: string): Transform[] {
  if (as === "number") {
    return MONEY.test(sample)
      ? [{ kind: "trim" }, { kind: "currencyToNumber", currency: "USD" }]
      : [{ kind: "trim" }, { kind: "toNumber" }];
  }
  return [{ kind: "trim" }];
}

/**
 * Assembles the draft capability.
 *
 * Discovery NEVER approves its own artifact: status is always "draft", risk is derived
 * from what the recorded actions actually do, and any weak target is listed for review.
 */
export function finalizeCapability(args: FinalizeArgs): Capability {
  const steps: Step[] = args.steps.map((s, i) => {
    const next = args.steps[i + 1];
    const nextTarget = next && "target" in next.action ? next.action.target : undefined;

    // A step's checkpoint asserts that the NEXT control became reachable - i.e. that this
    // action actually moved the app forward, rather than assuming the click worked.
    const checkpoint: Condition | null = nextTarget
      ? { kind: "exists", target: nextTarget }
      : args.outputs[0]
        ? { kind: "exists", target: args.outputs[0].target }
        : null;

    const target = "target" in s.action ? s.action.target : undefined;
    const weak = target ? isWeak(target) : false;

    return {
      id: `s${i + 1}`,
      intent: s.rationale.slice(0, 200) || `Step ${i + 1}`,
      action: s.action,
      checkpoint,
      ...(checkpoint === null
        ? {
            checkpointOmittedReason:
              "This is the final recorded step and the capability declares no outputs to assert against.",
          }
        : {}),
      robustness: weak ? ("weak" as const) : ("strong" as const),
      ...(weak
        ? { robustnessNote: "Positional targeting was the only option; review before approval." }
        : {}),
      provenance: s.provenance,
    };
  });

  const outputs: Record<string, Capability["outputs"][string]> = {};
  for (const o of args.outputs) {
    outputs[o.field] = {
      type: o.as,
      description: `Value read from the ${o.target.expectedRole} identified during discovery.`,
      required: true,
      sensitivity: guessSensitivity(o.field),
      source: { from: o.afterStepId, target: o.target, read: "value" },
      transform: transformsFor(o.as, o.sampleValue),
    };
  }

  const weakTargets = steps.filter((s) => s.robustness === "weak").map((s) => s.id);

  return {
    schemaVersion: "1.0",
    id: args.id,
    version: "1.0.0",
    title: args.title,
    description: args.description,
    app: {
      product: args.product ?? "corebank-teller",
      productVersion: args.productVersion ?? "8.x",
      variant: "base",
      entry: { path: args.entryPath },
    },
    entryCheckpoint: args.entryCheckpoint,
    // Discovery never approves its own work.
    status: "draft",
    risk: maxRisk(args.steps.map((s) => s.action)),
    inputs: args.inputs,
    outputs,
    preconditions: [],
    steps,
    successCheckpoint: args.successCheckpoint,
    ...(args.inheritsOutcomesFrom ? { inheritsOutcomesFrom: args.inheritsOutcomesFrom } : {}),
    // Discovery records only conditions it actually encountered. It did not hit any on a
    // successful run, so the outcome table is inherited from the app profile and curated
    // by a human at review - inventing detectors it never saw would be fiction.
    outcomes: [],
    escalation: {
      onHardFailure: "escalate",
      onUnresolvedTarget: "escalate",
      onAmbiguousTarget: "escalate",
      onUnknownState: "escalate",
      operatorTimeoutSeconds: 900,
    },
    provenance: {
      generatedBy: "llm-discovery",
      discoveredAt: new Date().toISOString(),
      runId: args.runId,
      provider: args.provider,
      model: args.model,
      evidenceRunRef: args.evidenceRunRef,
      goal: args.goal,
      llmStepCount: args.steps.filter((s) => s.provenance === "llm").length,
      humanStepCount: args.steps.filter((s) => s.provenance === "human").length,
    },
    review: {
      notes:
        "Generated by an LLM discovery run. Requires human review before approval: confirm the risk class, the output sensitivities, and any weak targets.",
      weakTargets,
    },
  };
}
