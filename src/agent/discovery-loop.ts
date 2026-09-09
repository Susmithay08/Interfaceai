import type { Capability } from "../model/capability.js";
import type { ActionKind, StepAction } from "../model/action.js";
import type { Observation, UiNode } from "../model/observation.js";
import type { EvidenceSink } from "../model/evidence.js";
import type { EscalationReason } from "../model/escalation.js";
import type { Ref } from "../model/ids.js";
import type { TargetDescriptor } from "../model/target.js";
import type { Surface } from "../surface/surface.js";
import type { PolicyEngine } from "../policy/policy-engine.js";
import type { ControlLease } from "../session/control-lease.js";
import type { EscalationService } from "../session/escalation.js";
import { redactText } from "../policy/redaction.js";
import { resolveTarget } from "../resolution/resolve-target.js";
import { bindTarget } from "../resolution/bind.js";
import { readNode } from "../resolution/extract.js";
import type {
  AgentDecision,
  DecisionSummary,
  LlmClient,
  ObservedNode,
} from "./llm/llm-client.js";
import {
  describeTarget,
  finalizeCapability,
  type RecordedOutput,
  type RecordedStep,
} from "./recorder.js";

export interface DiscoveryDeps {
  readonly surface: Surface;
  readonly policy: PolicyEngine;
  readonly evidence: EvidenceSink;
  readonly escalation: EscalationService;
  readonly lease: ControlLease;
  readonly llm: LlmClient;
  readonly baseUrl: string;
}

export interface DiscoveryOptions {
  readonly goal: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly entryPath: string;
  readonly runId: string;
  readonly capabilityId: string;
  readonly maxSteps?: number;
  readonly wallClockMs?: number;
  /** Identical screens in a row before the loop concludes it is going nowhere. */
  readonly noProgressLimit?: number;
}

export type DiscoveryResult =
  | { readonly status: "recorded"; readonly capability: Capability; readonly stepCount: number }
  | {
      readonly status: "escalated";
      readonly interventionId: string;
      readonly reason: EscalationReason;
      readonly detail: string;
    };

const DEFAULTS = { maxSteps: 20, wallClockMs: 180_000, noProgressLimit: 3 };

/** Discovery may look and type. It may not navigate away or wait on a declared condition. */
const DISCOVERY_ACTIONS: readonly ActionKind[] = ["click", "fill", "select", "pressKey", "dismiss"];

/**
 * observe -> redact -> decide -> self-validate -> policy -> act, bounded on every axis.
 *
 * The model never authors a selector and never touches the browser: it points at a ref,
 * the recorder turns that into a durable descriptor (or refuses), policy vets the action,
 * and only then does the surface execute. Every refusal is fed back as a note so the model
 * re-plans inside the bounds rather than the run dying on it.
 */
export class DiscoveryLoop {
  readonly #history: DecisionSummary[] = [];
  readonly #steps: RecordedStep[] = [];
  readonly #outputs: RecordedOutput[] = [];
  #signatures: string[] = [];

  constructor(private readonly deps: DiscoveryDeps) {}

  async run(opts: DiscoveryOptions): Promise<DiscoveryResult> {
    const maxSteps = opts.maxSteps ?? DEFAULTS.maxSteps;
    const wallClockMs = opts.wallClockMs ?? DEFAULTS.wallClockMs;
    const noProgressLimit = opts.noProgressLimit ?? DEFAULTS.noProgressLimit;
    const started = Date.now();

    this.deps.evidence.event({
      type: "run_started",
      runId: opts.runId,
      mode: "discovery",
      goal: opts.goal,
      at: new Date().toISOString(),
    });

    const result = await this.#loop(opts, { maxSteps, wallClockMs, noProgressLimit, started });

    this.deps.evidence.event({
      type: "run_finished",
      runId: opts.runId,
      status: result.status,
      durationMs: Date.now() - started,
      at: new Date().toISOString(),
    });
    return result;
  }

  async #loop(
    opts: DiscoveryOptions,
    limits: { maxSteps: number; wallClockMs: number; noProgressLimit: number; started: number },
  ): Promise<DiscoveryResult> {
    this.deps.lease.acquire("automation", "discovery run");

    const entryUrl = new URL(opts.entryPath, this.deps.baseUrl).toString();
    const nav = this.deps.policy.checkNavigation(entryUrl);
    this.#policyEvent("navigate", nav);
    if (nav.allow !== "yes") {
      return this.#escalate(opts, "policyRequiresConfirmation", `entry blocked: ${reason(nav)}`);
    }
    await this.deps.surface.execute({ kind: "navigate", url: entryUrl });

    let entryCheckpoint: TargetDescriptor | null = null;
    let pendingNote: string | undefined;

    for (let turn = 1; turn <= limits.maxSteps; turn++) {
      if (Date.now() - limits.started > limits.wallClockMs) {
        return this.#escalate(opts, "maxSteps", `wall clock of ${limits.wallClockMs}ms exceeded`);
      }

      const observation = await this.deps.surface.observe();
      this.#recordObservation(observation);

      if (this.#stalled(limits.noProgressLimit)) {
        return this.#escalate(
          opts,
          "noProgress",
          `the screen did not change across ${limits.noProgressLimit} consecutive actions`,
        );
      }

      const decision = await this.deps.llm.decide({
        goal: opts.goal,
        inputs: mapValues(opts.inputs, redactText),
        ...(observation.title === undefined ? {} : { screenTitle: observation.title }),
        nodes: this.deps.policy.redactObservation(observation).nodes.map(toObservedNode),
        history: pendingNote ? withNote(this.#history, pendingNote) : this.#history,
        allowedActions: DISCOVERY_ACTIONS,
      });
      pendingNote = undefined;
      this.#recordDecision(decision);

      if (decision.kind === "stuck") {
        return this.#escalate(opts, "agentStuck", decision.reason);
      }

      if (decision.kind === "done") {
        if (this.#outputs.length === 0) {
          pendingNote = "you reported done but extracted no value yet - extract it first";
          continue;
        }
        break;
      }

      const target = this.#describe(decision.ref, observation, opts.inputs);
      if (!target) {
        pendingNote = notARecordableTarget(decision.ref);
        continue;
      }
      entryCheckpoint ??= target;

      if (decision.kind === "extract") {
        const node = observation.nodes.find((n) => n.ref === decision.ref)!;
        const sample = readNode(node, "value") ?? readNode(node, "text") ?? "";
        this.#outputs.push({
          field: decision.field,
          as: decision.as,
          target,
          sampleValue: sample,
          afterStepId: `s${this.#steps.length}`,
        });
        this.deps.evidence.event({
          type: "extraction",
          output: decision.field,
          ok: sample !== "",
          detail: redactText(sample),
          at: new Date().toISOString(),
        });
        this.#history.push(summary(turn, `extract ${decision.field}`, decision.rationale));
        continue;
      }

      const action = toStepAction(decision, target, opts.inputs);
      if (!action) {
        pendingNote = `input "${inputNameOf(decision)}" is not one of the available inputs`;
        continue;
      }

      const verdict = this.deps.policy.checkAction(action, { mode: "discovery", unattended: true });
      this.#policyEvent(action.kind, verdict);
      if (verdict.allow !== "yes") {
        // Fed back, not fatal: the model re-plans inside the allowlist.
        pendingNote = `policy refused that action: ${reason(verdict)} - choose a different one`;
        this.#history.push(summary(turn, action.kind, decision.rationale, pendingNote));
        continue;
      }

      await this.#act(action, decision.ref, opts.inputs, turn);
      this.#steps.push({ action, rationale: decision.rationale, provenance: "llm" });
      this.#history.push(summary(turn, action.kind, decision.rationale));
    }

    if (this.#outputs.length === 0 || this.#steps.length === 0) {
      return this.#escalate(opts, "maxSteps", `gave up after ${limits.maxSteps} turns`);
    }

    const last = this.#outputs.at(-1)!;
    const capability = finalizeCapability({
      id: opts.capabilityId,
      title: opts.goal.slice(0, 120),
      description: `Discovered from the goal: ${opts.goal}`,
      goal: opts.goal,
      entryPath: opts.entryPath,
      entryCheckpoint: { kind: "exists", target: entryCheckpoint ?? last.target },
      inputs: declaredInputs(opts.inputs),
      steps: this.#steps,
      outputs: this.#outputs,
      successCheckpoint: { kind: "exists", target: last.target },
      provider: this.deps.llm.provider,
      model: this.deps.llm.model,
      runId: opts.runId,
      evidenceRunRef: this.deps.evidence.runDir,
    });

    return { status: "recorded", capability, stepCount: this.#steps.length };
  }

  /* ── pieces ─────────────────────────────────────────────────────────── */

  /** Self-validation: a descriptor that will not resolve back to this node is not recorded. */
  #describe(
    ref: Ref,
    observation: Observation,
    inputs: Readonly<Record<string, string>>,
  ): TargetDescriptor | null {
    const t = describeTarget(ref, observation, inputs);
    if (!t) return null;
    const bound = bindTarget(t, { inputs, outputs: {}, credentials: () => undefined });
    if (!bound.ok) return null;
    const r = resolveTarget(bound.target, observation);
    return r.ok && r.ref === ref ? t : null;
  }

  async #act(
    action: StepAction,
    ref: Ref,
    inputs: Readonly<Record<string, string>>,
    turn: number,
  ): Promise<void> {
    const started = Date.now();
    switch (action.kind) {
      case "fill":
      case "select": {
        const value = valueOf(action, inputs);
        await this.deps.surface.execute({ kind: action.kind, ref, value });
        break;
      }
      case "pressKey":
        await this.deps.surface.execute({ kind: "pressKey", key: action.key, ref });
        break;
      default:
        await this.deps.surface.execute({ kind: action.kind === "dismiss" ? "dismiss" : "click", ref });
    }
    this.deps.evidence.event({
      type: "action",
      stepId: `s${turn}`,
      actionKind: action.kind,
      resolutionTier: 0,
      durationMs: Date.now() - started,
      at: new Date().toISOString(),
    });
  }

  #recordObservation(o: Observation): void {
    const ref = this.deps.evidence.attach("observation", o.observationId, o);
    this.deps.evidence.event({
      type: "observation",
      observationId: o.observationId,
      screenSignature: o.screenSignature,
      nodeCount: o.nodes.length,
      ...(o.locationHint === undefined ? {} : { locationHint: o.locationHint }),
      ref: ref.path,
      at: new Date().toISOString(),
    });
    this.#signatures.push(o.screenSignature);
  }

  #recordDecision(d: AgentDecision): void {
    this.deps.evidence.event({
      type: "llm_decision",
      provider: this.deps.llm.provider,
      model: this.deps.llm.model,
      decision: d.kind === "act" ? `act:${d.action.kind}` : d.kind,
      rationale: d.kind === "act" || d.kind === "extract" ? d.rationale : describeTerminal(d),
      ...("ref" in d ? { targetRef: d.ref } : {}),
      at: new Date().toISOString(),
    });
  }

  #policyEvent(kind: string, verdict: { allow: string }): void {
    this.deps.evidence.event({
      type: "policy_verdict",
      actionKind: kind,
      verdict: verdict.allow,
      risk: "readOnly",
      ...("reason" in verdict ? { reason: String(verdict.reason) } : {}),
      at: new Date().toISOString(),
    });
  }

  /** `limit` consecutive actions that left the screen identical means the loop is going nowhere. */
  #stalled(limit: number): boolean {
    const recent = this.#signatures.slice(-(limit + 1));
    return recent.length > limit && new Set(recent).size === 1;
  }

  async #escalate(
    opts: DiscoveryOptions,
    reasonCode: EscalationReason,
    detail: string,
  ): Promise<DiscoveryResult> {
    const screenshot = await this.deps.surface.capture(`escalation-${reasonCode}`);
    const intervention = this.deps.escalation.raise({
      runId: opts.runId,
      mode: "discovery",
      goal: opts.goal,
      reason: reasonCode,
      observed: detail,
      screenshotRef: screenshot.path,
      resumePlan: { resumeAtStepId: null, mode: "retryStep" },
    });
    if (this.deps.lease.holder() === "automation") {
      this.deps.lease.transfer("automation", "operator", `escalation ${intervention.id}`);
      this.deps.evidence.event({
        type: "control_transfer",
        from: "automation",
        to: "operator",
        reason: `escalation ${intervention.id}`,
        at: new Date().toISOString(),
      });
    }
    return {
      status: "escalated",
      interventionId: intervention.id,
      reason: reasonCode,
      detail,
    };
  }
}

/* ── helpers ────────────────────────────────────────────────────────────── */

const reason = (v: { allow: string; reason?: string }): string => v.reason ?? v.allow;

const describeTerminal = (d: AgentDecision): string =>
  d.kind === "done" ? d.summary : d.kind === "stuck" ? d.reason : "";

const summary = (step: number, action: string, rationale: string, note?: string): DecisionSummary =>
  ({ step, action, rationale, ...(note === undefined ? {} : { note }) });

const withNote = (h: readonly DecisionSummary[], note: string): DecisionSummary[] => [
  ...h,
  { step: h.length + 1, action: "(no action taken)", rationale: "", note },
];

const notARecordableTarget = (ref: string): string =>
  `control "${ref}" has no label, name or table anchor that would still find it on a later ` +
  `run, so it cannot be recorded - pick a control identified by its label, its accessible ` +
  `name, or its row and column`;

function mapValues(
  o: Readonly<Record<string, string>>,
  f: (v: string) => string,
): Record<string, string> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));
}

function toObservedNode(n: UiNode): ObservedNode {
  return {
    ref: n.ref,
    role: n.role,
    ...(n.name === undefined ? {} : { name: n.name }),
    ...(n.value === undefined ? {} : { value: n.value }),
    ...(n.scope.region ? { region: n.scope.region.value } : {}),
    frame: n.scope.path.map((s) => String(s.value)).join(">") || "top",
    anchors: n.anchors.map((a) => `${a.kind}:${a.text}`),
  };
}

const inputNameOf = (d: AgentDecision): string =>
  d.kind === "act" && (d.action.kind === "fill" || d.action.kind === "select")
    ? d.action.inputName
    : "";

/** The model names an input; it never supplies the value. Nothing it typed is persisted. */
function toStepAction(
  d: Extract<AgentDecision, { kind: "act" }>,
  target: TargetDescriptor,
  inputs: Readonly<Record<string, string>>,
): StepAction | null {
  switch (d.action.kind) {
    case "click":
      return { kind: "click", target };
    case "dismiss":
      return { kind: "dismiss", target };
    case "pressKey":
      return { kind: "pressKey", key: d.action.key, target };
    case "fill":
    case "select": {
      const name = d.action.inputName;
      if (!(name in inputs)) return null;
      return { kind: d.action.kind, target, value: { from: "input", name } };
    }
  }
}

/** The live value stays in memory: it is bound here and never written into the artifact. */
function valueOf(action: StepAction, inputs: Readonly<Record<string, string>>): string {
  if (action.kind !== "fill" && action.kind !== "select") return "";
  const v = action.value;
  if (v.from === "literal") return v.value;
  if (v.from === "input") return inputs[v.name] ?? "";
  return "";
}

function declaredInputs(inputs: Readonly<Record<string, string>>): Capability["inputs"] {
  const out: Record<string, Capability["inputs"][string]> = {};
  for (const [name, example] of Object.entries(inputs)) {
    out[name] = {
      type: "string",
      description: `Supplied by the caller at replay time. Discovery used "${redactText(example)}".`,
      required: true,
      sensitivity: /id$|number|account/i.test(name) ? "identifier" : "none",
      example,
    };
  }
  return out;
}
