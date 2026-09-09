import type { Capability, OutcomeDefinition, Step } from "../model/capability.js";
import type { ResolvedAction, StepAction } from "../model/action.js";
import type { Observation } from "../model/observation.js";
import type { EvidenceSink } from "../model/evidence.js";
import type {
  FailureCode,
  ReplayResult,
  ResolutionReportEntry,
  StepTrace,
} from "../model/result.js";
import type { EscalationReason } from "../model/escalation.js";
import type { StrategyAttempt } from "../model/target.js";
import type { Surface } from "../surface/surface.js";
import type { PolicyEngine } from "../policy/policy-engine.js";
import type { ControlLease } from "../session/control-lease.js";
import type { EscalationService } from "../session/escalation.js";
import { resolveTarget } from "../resolution/resolve-target.js";
import { evaluateCondition } from "../resolution/evaluate.js";
import { applyTransforms, readNode } from "../resolution/extract.js";
import { bindCondition, bindTarget, bindValue, type BindContext } from "../resolution/bind.js";
import { checkOutcomes, type OutcomeHit } from "./outcome-checker.js";
import { waitFor } from "./waiter.js";

/**
 * NOTE: this module imports no LLM client and no discovery code, and it cannot - the
 * architecture test asserts that src/replay never reaches src/agent or a provider SDK.
 * Replay is a plain loop over recorded steps. Nothing here asks a model what to do.
 */

export interface ReplayDeps {
  readonly surface: Surface;
  readonly policy: PolicyEngine;
  readonly evidence: EvidenceSink;
  readonly escalation: EscalationService;
  readonly lease: ControlLease;
  readonly baseUrl: string;
  readonly outcomes: readonly OutcomeDefinition[];
  readonly credentials: (ref: string) => string | undefined;
}

export interface ReplayOptions {
  readonly unattended: boolean;
  readonly runId: string;
  /** Overrides the artifact's operator timeout. Shorter for demos and tests, never longer silently. */
  readonly operatorTimeoutSeconds?: number;
}

// How long a step waits for its control to appear before giving up. Generous on purpose:
// a legacy page that is still rendering is not an unresolved target, and escalating to a
// human over a slow render is worse than waiting a few more seconds.
const RESOLVE_RETRY_MS = 10_000;
const RESOLVE_POLL_MS = 250;

export class ReplayEngine {
  #steps: StepTrace[] = [];
  #resolution: ResolutionReportEntry[] = [];
  #outputs: Record<string, unknown> = {};
  #recoveryAttempts = new Map<string, number>();

  constructor(private readonly deps: ReplayDeps) {}

  async replay(
    capability: Capability,
    inputs: Readonly<Record<string, unknown>>,
    opts: ReplayOptions,
  ): Promise<ReplayResult> {
    const started = Date.now();
    this.#steps = [];
    this.#resolution = [];
    this.#outputs = {};
    this.#recoveryAttempts = new Map();

    this.deps.evidence.event({
      type: "run_started",
      runId: opts.runId,
      mode: "replay",
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      goal: capability.title,
      at: new Date().toISOString(),
    });

    const result = await this.#run(capability, inputs, opts);

    this.deps.evidence.event({
      type: "run_finished",
      runId: opts.runId,
      status: result.status,
      ...("code" in result && result.code ? { code: result.code } : {}),
      durationMs: Date.now() - started,
      at: new Date().toISOString(),
    });
    return result;
  }

  async #run(
    capability: Capability,
    rawInputs: Readonly<Record<string, unknown>>,
    opts: ReplayOptions,
  ): Promise<ReplayResult> {
    // 1. Validate inputs BEFORE a browser is touched. A bad input is a business
    //    outcome the caller needs, not a crash halfway through a banking screen.
    const validation = validateInputs(capability, rawInputs);
    if (!validation.ok) {
      return {
        status: "business_outcome",
        code: "INVALID_INPUT",
        message: validation.error,
        steps: [],
        evidenceRef: this.deps.evidence.runDir,
      };
    }

    const ctx: BindContext = {
      inputs: validation.inputs,
      outputs: this.#outputs,
      credentials: this.deps.credentials,
    };

    // 2. Approval gate. A draft capability does not run unattended.
    const gate = this.deps.policy.checkAction(capability.steps[0]!.action, {
      mode: "replay",
      approval: capability.status,
      unattended: opts.unattended,
    });
    if (gate.allow === "withConfirmation") {
      return this.#escalate(capability, "riskyAction", gate.reason, null, opts);
    }
    if (gate.allow === "no") {
      return this.#fail(null, "POLICY_BLOCKED", gate.reason, "action blocked by policy", []);
    }

    // 3. Enter the app.
    const entryUrl = buildEntryUrl(this.deps.baseUrl, capability, ctx);
    if (!entryUrl.ok) {
      return this.#fail(null, "BINDING_FAILED", "resolvable entry path", entryUrl.error, []);
    }
    const navVerdict = this.deps.policy.checkNavigation(entryUrl.url);
    this.deps.evidence.event({
      type: "policy_verdict",
      actionKind: "navigate",
      verdict: navVerdict.allow,
      risk: "readOnly",
      ...("reason" in navVerdict ? { reason: navVerdict.reason } : {}),
      at: new Date().toISOString(),
    });
    if (navVerdict.allow !== "yes") {
      return this.#fail(null, "POLICY_BLOCKED", "allowlisted entry URL", entryUrl.url, []);
    }
    const entered = await this.#enterApp(capability, ctx, entryUrl.url, opts);
    if (entered.kind === "terminal") return entered.result;

    // 4. Preconditions.
    for (const [i, pre] of capability.preconditions.entries()) {
      const r = await this.#assert(pre, ctx, `precondition ${i}`);
      if (!r.ok) {
        return this.#fail(null, "PRECONDITION_FAILED", `precondition ${i}`, r.detail, []);
      }
    }

    // 5. The steps. A plain loop - no planner, no model.
    let index = 0;
    let guard = 0;
    const maxIterations = capability.steps.length * 6;

    while (index < capability.steps.length) {
      if (++guard > maxIterations) {
        return this.#fail(
          capability.steps[index]!.id,
          "RECOVERY_EXHAUSTED",
          "bounded progress",
          `exceeded ${maxIterations} step iterations - recovery is looping`,
          [],
        );
      }

      const step = capability.steps[index]!;
      const outcome = await this.#runStep(step, ctx, capability, opts);

      switch (outcome.kind) {
        case "advance":
          index++;
          break;
        case "retryStep":
          break; // same index, run it again
        case "continueAfter":
          index++;
          break;
        case "restart":
          index = 0;
          break;
        case "terminal":
          return outcome.result;
      }
    }

    // 6. Success checkpoint gates extraction: nothing is returned from a run that did
    //    not actually reach the state the artifact says it should have reached.
    const success = await this.#assert(capability.successCheckpoint, ctx, "successCheckpoint");
    if (!success.ok) {
      return this.#fail(
        capability.steps.at(-1)?.id ?? null,
        "CHECKPOINT_FAILED",
        "success checkpoint",
        success.detail,
        [],
      );
    }

    // 7. Extract typed outputs.
    const extraction = await this.#extractOutputs(capability, ctx);
    if (!extraction.ok) {
      return this.#fail(
        extraction.stepId,
        "EXTRACTION_FAILED",
        `output "${extraction.output}"`,
        extraction.error,
        [],
      );
    }

    return {
      status: "success",
      outputs: { ...this.#outputs },
      steps: this.#steps,
      evidenceRef: this.deps.evidence.runDir,
      resolutionReport: this.#resolution,
    };
  }

  /**
   * Entering the app is subject to the same outcome table as any step: arriving at a
   * sign-on screen is a declared recoverable condition, not an entry failure. Recovery
   * reuses the identical bounded machinery via a synthetic step.
   */
  async #enterApp(
    capability: Capability,
    ctx: BindContext,
    url: string,
    opts: ReplayOptions,
  ): Promise<{ kind: "ok" } | { kind: "terminal"; result: ReplayResult }> {
    const pseudoStep: Step = {
      id: "entry",
      intent: "Enter the application at its recorded entry point",
      action: { kind: "wait", for: capability.entryCheckpoint, timeoutMs: 1000, pollMs: 250 },
      checkpoint: null,
      checkpointOmittedReason: "The entry checkpoint is asserted directly by #enterApp.",
      robustness: "strong",
      provenance: "human",
    };

    for (let attempt = 0; attempt < 4; attempt++) {
      await this.deps.surface.execute({ kind: "navigate", url });

      const observation = await this.deps.surface.observe();
      const hit = checkOutcomes(this.deps.outcomes, pseudoStep.id, observation, ctx);
      if (hit) {
        const handled = await this.#handleOutcome(hit, pseudoStep, ctx, capability, opts);
        if (handled.kind === "terminal") return handled;
        continue; // recovery ran; re-enter and look again
      }

      const entry = await this.#assert(capability.entryCheckpoint, ctx, "entry", observation);
      if (entry.ok) return { kind: "ok" };
    }

    return {
      kind: "terminal",
      result: this.#fail(
        null,
        "ENTRY_FAILED",
        "entry checkpoint after recovery",
        "the entry screen never became available",
        [],
      ),
    };
  }

  async #runStep(
    step: Step,
    ctx: BindContext,
    capability: Capability,
    opts: ReplayOptions,
  ): Promise<
    | { kind: "advance" | "retryStep" | "continueAfter" | "restart" }
    | { kind: "terminal"; result: ReplayResult }
  > {
    const started = Date.now();

    // Policy first, always, for both discovery and replay.
    const verdict = this.deps.policy.checkAction(step.action, {
      mode: "replay",
      approval: capability.status,
      unattended: opts.unattended,
    });
    this.deps.evidence.event({
      type: "policy_verdict",
      actionKind: step.action.kind,
      verdict: verdict.allow,
      risk: this.deps.policy.classify(step.action),
      ...("reason" in verdict ? { reason: verdict.reason } : {}),
      at: new Date().toISOString(),
    });

    if (verdict.allow === "no") {
      return {
        kind: "terminal",
        result: this.#fail(step.id, "POLICY_BLOCKED", "permitted action", verdict.reason, []),
      };
    }
    if (verdict.allow === "withConfirmation") {
      return {
        kind: "terminal",
        result: await this.#escalate(capability, "riskyAction", verdict.reason, step, opts),
      };
    }

    // Perform the action.
    const performed = await this.#perform(step.action, ctx, step.id);
    if (!performed.ok) {
      // Before calling an unresolved target a failure, check whether the app is in a
      // state the artifact knows about - an interstitial is why the control is missing.
      const observation = await this.deps.surface.observe();
      const hit = checkOutcomes(this.deps.outcomes, step.id, observation, ctx);
      if (hit) return this.#handleOutcome(hit, step, ctx, capability, opts);

      return {
        kind: "terminal",
        result: this.#fail(
          step.id,
          performed.code,
          performed.expected,
          performed.observed,
          performed.attempts,
        ),
      };
    }

    this.#steps.push({
      stepId: step.id,
      intent: step.intent,
      actionKind: step.action.kind,
      tier: performed.tier,
      durationMs: Date.now() - started,
    });
    this.deps.evidence.event({
      type: "action",
      stepId: step.id,
      intent: step.intent,
      actionKind: step.action.kind,
      resolutionTier: performed.tier,
      ...(performed.strategyKind === undefined
        ? {}
        : { strategyKind: performed.strategyKind }),
      durationMs: Date.now() - started,
      at: new Date().toISOString(),
    });
    if (performed.tier !== null && performed.strategyKind !== undefined) {
      this.#resolution.push({
        stepId: step.id,
        tier: performed.tier,
        strategyKind: performed.strategyKind,
      });
    }

    // Outcome check comes BEFORE the checkpoint, every step.
    const observation = await this.deps.surface.observe();
    const hit = checkOutcomes(this.deps.outcomes, step.id, observation, ctx);
    if (hit) return this.#handleOutcome(hit, step, ctx, capability, opts);

    // Checkpoint.
    if (step.checkpoint !== null) {
      const check = await this.#assert(step.checkpoint, ctx, step.id, observation);
      this.deps.evidence.event({
        type: "checkpoint",
        stepId: step.id,
        passed: check.ok,
        detail: check.detail,
        ...(check.observed === undefined ? {} : { observed: check.observed }),
        at: new Date().toISOString(),
      });
      if (!check.ok) {
        return {
          kind: "terminal",
          result: await this.#escalateOrFail(
            capability,
            "checkpointFailed",
            step,
            "CHECKPOINT_FAILED",
            `checkpoint for ${step.id}`,
            check.detail,
            opts,
          ),
        };
      }
    }

    return { kind: "advance" };
  }

  async #handleOutcome(
    hit: OutcomeHit,
    step: Step,
    ctx: BindContext,
    capability: Capability,
    opts: ReplayOptions,
  ): Promise<
    | { kind: "advance" | "retryStep" | "continueAfter" | "restart" }
    | { kind: "terminal"; result: ReplayResult }
  > {
    const { definition } = hit;
    this.deps.evidence.event({
      type: "outcome_detected",
      stepId: step.id,
      code: definition.code,
      outcomeClass: definition.class,
      ...(hit.observed === undefined ? {} : { observed: hit.observed }),
      at: new Date().toISOString(),
    });

    if (definition.class === "business") {
      await this.deps.surface.capture(`business-${definition.code}`);
      return {
        kind: "terminal",
        result: {
          status: "business_outcome",
          code: definition.code,
          ...(hit.message === undefined ? {} : { message: hit.message }),
          steps: this.#steps,
          evidenceRef: this.deps.evidence.runDir,
        },
      };
    }

    if (definition.class === "hard") {
      await this.deps.surface.capture(`hard-${definition.code}`);
      return {
        kind: "terminal",
        result: await this.#escalateOrFail(
          capability,
          "riskyAction",
          step,
          "UNKNOWN_STATE",
          `no declared outcome permitting progress`,
          `${definition.code}: ${definition.description}`,
          opts,
          definition.escalate === true,
        ),
      };
    }

    // Recoverable: bounded, declared, non-branching.
    const recovery = definition.recovery;
    if (!recovery) {
      return {
        kind: "terminal",
        result: this.#fail(step.id, "UNKNOWN_STATE", "a declared recovery", definition.code, []),
      };
    }

    const key = `${step.id}:${definition.code}`;
    const attempt = (this.#recoveryAttempts.get(key) ?? 0) + 1;
    this.#recoveryAttempts.set(key, attempt);

    if (attempt > recovery.maxAttempts) {
      await this.deps.surface.capture(`recovery-exhausted-${definition.code}`);
      return {
        kind: "terminal",
        result: await this.#escalateOrFail(
          capability,
          "recoveryExhausted",
          step,
          "RECOVERY_EXHAUSTED",
          `${definition.code} cleared within ${recovery.maxAttempts} attempts`,
          `still present after ${recovery.maxAttempts} attempts`,
          opts,
        ),
      };
    }

    for (const action of recovery.actions) {
      const verdict = this.deps.policy.checkAction(action, {
        mode: "replay",
        approval: capability.status,
        unattended: opts.unattended,
      });
      if (verdict.allow !== "yes") {
        return {
          kind: "terminal",
          result: this.#fail(
            step.id,
            "POLICY_BLOCKED",
            "permitted recovery action",
            "reason" in verdict ? verdict.reason : "blocked",
            [],
          ),
        };
      }
      const done = await this.#perform(action, ctx, step.id);
      if (!done.ok) {
        return {
          kind: "terminal",
          result: this.#fail(step.id, done.code, done.expected, done.observed, done.attempts),
        };
      }
    }

    let verified: boolean | undefined;
    if (recovery.verify) {
      const v = await this.#assert(recovery.verify, ctx, `${definition.code} recovery`);
      verified = v.ok;
      if (!v.ok) {
        return {
          kind: "terminal",
          result: await this.#escalateOrFail(
            capability,
            "recoveryExhausted",
            step,
            "RECOVERY_EXHAUSTED",
            "recovery verification",
            v.detail,
            opts,
          ),
        };
      }
    }

    this.deps.evidence.event({
      type: "recovery_attempt",
      stepId: step.id,
      code: definition.code,
      attempt,
      maxAttempts: recovery.maxAttempts,
      resume: recovery.resume,
      ...(verified === undefined ? {} : { verified }),
      at: new Date().toISOString(),
    });

    return { kind: recovery.resume };
  }

  /** Bind -> resolve -> execute. The invariant: persistent target, then ephemeral ref. */
  async #perform(
    action: StepAction,
    ctx: BindContext,
    stepId: string,
  ): Promise<
    | { ok: true; tier: number | null; strategyKind?: string }
    | {
        ok: false;
        code: FailureCode;
        expected: string;
        observed: string;
        attempts: readonly StrategyAttempt[];
      }
  > {
    if (action.kind === "wait") {
      const bound = bindCondition(action.for, ctx);
      if (!bound.ok) {
        return {
          ok: false,
          code: "BINDING_FAILED",
          expected: "bindable wait condition",
          observed: bound.error,
          attempts: [],
        };
      }
      const r = await waitFor(
        bound.condition,
        () => this.deps.surface.observe(),
        action.timeoutMs,
        action.pollMs,
      );
      return r.ok
        ? { ok: true, tier: null }
        : {
            ok: false,
            code: "WAIT_TIMEOUT",
            expected: `condition within ${action.timeoutMs}ms`,
            observed: `${r.detail} (after ${r.elapsedMs}ms, ${r.attempts} polls)`,
            attempts: [],
          };
    }

    if (action.kind === "navigate") {
      const url = bindPath(this.deps.baseUrl, action.path, ctx);
      if (!url.ok) {
        return {
          ok: false,
          code: "BINDING_FAILED",
          expected: "bindable path",
          observed: url.error,
          attempts: [],
        };
      }
      if (this.deps.policy.checkNavigation(url.url).allow !== "yes") {
        return {
          ok: false,
          code: "POLICY_BLOCKED",
          expected: "allowlisted URL",
          observed: url.url,
          attempts: [],
        };
      }
      await this.deps.surface.execute({ kind: "navigate", url: url.url });
      return { ok: true, tier: null };
    }

    if (action.kind === "pressKey" && action.target === undefined) {
      await this.deps.surface.execute({ kind: "pressKey", key: action.key });
      return { ok: true, tier: null };
    }

    const target = "target" in action ? action.target : undefined;
    if (!target) {
      return {
        ok: false,
        code: "BINDING_FAILED",
        expected: "an action target",
        observed: `${action.kind} has no target`,
        attempts: [],
      };
    }

    const boundTarget = bindTarget(target, ctx);
    if (!boundTarget.ok) {
      return {
        ok: false,
        code: "BINDING_FAILED",
        expected: "bindable target parameters",
        observed: boundTarget.error,
        attempts: [],
      };
    }

    // Resolve, retrying briefly for a transient load, then give up deliberately.
    const deadline = Date.now() + RESOLVE_RETRY_MS;
    let observation = await this.deps.surface.observe();
    let resolution = resolveTarget(boundTarget.target, observation);
    while (!resolution.ok && resolution.reason === "notFound" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, RESOLVE_POLL_MS));
      observation = await this.deps.surface.observe();
      resolution = resolveTarget(boundTarget.target, observation);
    }

    if (!resolution.ok) {
      return {
        ok: false,
        code: resolution.reason === "ambiguous" ? "TARGET_AMBIGUOUS" : "TARGET_UNRESOLVED",
        expected: `exactly one ${boundTarget.target.expectedRole} (${boundTarget.target.rationale})`,
        observed: `${resolution.reason}, ${resolution.matchCount} candidate(s) after ${resolution.attempts.length} strateg${resolution.attempts.length === 1 ? "y" : "ies"}`,
        attempts: resolution.attempts,
      };
    }

    let resolved: ResolvedAction;
    switch (action.kind) {
      case "click":
        resolved = { kind: "click", ref: resolution.ref };
        break;
      case "dismiss":
        resolved = { kind: "dismiss", ref: resolution.ref };
        break;
      case "pressKey":
        resolved = { kind: "pressKey", key: action.key, ref: resolution.ref };
        break;
      case "fill":
      case "select": {
        const value = bindValue(action.value, ctx);
        if (!value.ok) {
          return {
            ok: false,
            code: "BINDING_FAILED",
            expected: "bindable value",
            observed: value.error,
            attempts: [],
          };
        }
        resolved =
          action.kind === "fill"
            ? { kind: "fill", ref: resolution.ref, value: value.value }
            : { kind: "select", ref: resolution.ref, value: value.value };
        break;
      }
    }

    try {
      await this.deps.surface.execute(resolved);
    } catch (err) {
      return {
        ok: false,
        code: "UNKNOWN_STATE",
        expected: `${action.kind} on ${boundTarget.target.expectedRole} at step ${stepId}`,
        observed: String(err),
        attempts: resolution.attempts,
      };
    }

    return { ok: true, tier: resolution.tier, strategyKind: resolution.strategyUsed.kind };
  }

  async #assert(
    condition: Parameters<typeof bindCondition>[0],
    ctx: BindContext,
    label: string,
    existing?: Observation,
  ): Promise<{ ok: boolean; detail: string; observed?: string }> {
    const bound = bindCondition(condition, ctx);
    if (!bound.ok) return { ok: false, detail: `${label}: ${bound.error}` };

    const observation = existing ?? (await this.deps.surface.observe());
    const result = evaluateCondition(bound.condition, observation);
    return {
      ok: result.passed,
      detail: `${label}: ${result.detail}`,
      ...(result.observed === undefined ? {} : { observed: result.observed }),
    };
  }

  async #extractOutputs(
    capability: Capability,
    ctx: BindContext,
  ): Promise<
    { ok: true } | { ok: false; output: string; stepId: string; error: string }
  > {
    const observation = await this.deps.surface.observe();

    for (const [name, spec] of Object.entries(capability.outputs)) {
      const bound = bindTarget(spec.source.target, ctx);
      if (!bound.ok) {
        if (!spec.required) continue;
        return { ok: false, output: name, stepId: spec.source.from, error: bound.error };
      }

      const resolution = resolveTarget(bound.target, observation);
      if (!resolution.ok) {
        this.deps.evidence.event({
          type: "extraction",
          output: name,
          ok: false,
          detail: `target ${resolution.reason}`,
          at: new Date().toISOString(),
        });
        if (!spec.required) continue;
        return {
          ok: false,
          output: name,
          stepId: spec.source.from,
          error: `target ${resolution.reason} after ${resolution.attempts.length} strategies`,
        };
      }

      const node = observation.nodes.find((n) => n.ref === resolution.ref)!;
      const raw = readNode(node, spec.source.read);
      if (raw === undefined) {
        if (!spec.required) continue;
        return {
          ok: false,
          output: name,
          stepId: spec.source.from,
          error: `node has no ${spec.source.read}`,
        };
      }

      const transformed = applyTransforms(raw, spec.transform);
      if (!transformed.ok) {
        this.deps.evidence.event({
          type: "extraction",
          output: name,
          ok: false,
          detail: transformed.error,
          at: new Date().toISOString(),
        });
        if (!spec.required) continue;
        return { ok: false, output: name, stepId: spec.source.from, error: transformed.error };
      }

      if (spec.type === "number" && typeof transformed.value !== "number") {
        return {
          ok: false,
          output: name,
          stepId: spec.source.from,
          error: `expected number, got ${typeof transformed.value}`,
        };
      }

      this.#outputs[name] = transformed.value;
      this.deps.evidence.event({
        type: "extraction",
        output: name,
        ok: true,
        at: new Date().toISOString(),
      });
    }
    return { ok: true };
  }

  async #escalateOrFail(
    capability: Capability,
    reason: EscalationReason,
    step: Step | null,
    code: FailureCode,
    expected: string,
    observed: string,
    opts: ReplayOptions,
    force = false,
  ): Promise<ReplayResult> {
    const policy =
      reason === "checkpointFailed"
        ? capability.escalation.onUnknownState
        : capability.escalation.onHardFailure;

    if (!force && policy === "fail") {
      return this.#fail(step?.id ?? null, code, expected, observed, []);
    }
    return this.#escalate(capability, reason, observed, step, opts, expected);
  }

  /**
   * Pause, hand the SAME live session to a human, and wait. On hand-back the current
   * step's checkpoint is re-asserted rather than assumed - the human is not required to
   * have left the state the automation wanted.
   */
  async #escalate(
    capability: Capability,
    reason: EscalationReason,
    detail: string,
    step: Step | null,
    opts: ReplayOptions,
    expected?: string,
  ): Promise<ReplayResult> {
    const screenshot = await this.deps.surface.capture(`escalation-${reason}`);
    const observation = await this.deps.surface.observe();
    const obsRef = this.deps.evidence.attach(
      "observation",
      `escalation-${Date.now()}`,
      observation,
    );

    const intervention = this.deps.escalation.raise({
      runId: opts.runId,
      mode: "replay",
      capabilityId: capability.id,
      goal: capability.title,
      ...(step ? { stepId: step.id, stepIntent: step.intent } : {}),
      reason,
      ...(expected === undefined ? {} : { expected }),
      observed: detail,
      observationRef: obsRef.path,
      screenshotRef: screenshot.path,
      resumePlan: { resumeAtStepId: step?.id ?? null, mode: "retryStep" },
    });

    // Cede control. From here, surface.execute() from automation throws.
    this.deps.lease.transfer("automation", "operator", `escalation ${intervention.id}`);
    this.deps.evidence.event({
      type: "control_transfer",
      from: "automation",
      to: "operator",
      reason: `escalation ${intervention.id}`,
      at: new Date().toISOString(),
    });

    try {
      await this.deps.lease.waitUntilHeldBy(
        "automation",
        (opts.operatorTimeoutSeconds ?? capability.escalation.operatorTimeoutSeconds) * 1000,
      );
    } catch {
      this.deps.escalation.timeOut(intervention.id, "no operator took control in time");
      return {
        status: "escalated",
        interventionId: intervention.id,
        reason,
        steps: this.#steps,
        evidenceRef: this.deps.evidence.runDir,
      };
    }

    this.deps.evidence.event({
      type: "control_transfer",
      from: "operator",
      to: "automation",
      reason: `resume ${intervention.id}`,
      at: new Date().toISOString(),
    });

    // Resume: re-observe and re-assert. Never assume the human left the wanted state.
    const resumeCheck = step?.checkpoint
      ? await this.#assert(step.checkpoint, {
          inputs: {},
          outputs: this.#outputs,
          credentials: this.deps.credentials,
        }, `${step.id} after handback`)
      : { ok: true, detail: "no checkpoint to re-assert" };

    this.deps.escalation.resolve(
      intervention.id,
      resumeCheck.ok ? "operator resolved; automation resumed" : "operator handed back",
    );

    return {
      status: "escalated",
      interventionId: intervention.id,
      reason,
      resumedBy: "operator",
      finalStatus: resumeCheck.ok ? "success" : "failed",
      steps: this.#steps,
      evidenceRef: this.deps.evidence.runDir,
    };
  }

  #fail(
    stepId: string | null,
    code: FailureCode,
    expected: string,
    observed: string,
    attempts: readonly StrategyAttempt[],
  ): ReplayResult {
    return {
      status: "failed",
      error: { stepId, class: "hard", code, expected, observed, attempts },
      steps: this.#steps,
      evidenceRef: this.deps.evidence.runDir,
    };
  }
}

/* ── helpers ──────────────────────────────────────────────────────────── */

type InputValidation =
  | { ok: true; inputs: Record<string, string | number | boolean> }
  | { ok: false; error: string };

export function validateInputs(
  capability: Capability,
  raw: Readonly<Record<string, unknown>>,
): InputValidation {
  const inputs: Record<string, string | number | boolean> = {};

  for (const [name, spec] of Object.entries(capability.inputs)) {
    const supplied = raw[name] ?? spec.default;
    if (supplied === undefined) {
      if (spec.required) return { ok: false, error: `missing required input "${name}"` };
      continue;
    }
    const value = String(supplied);

    if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
      return {
        ok: false,
        error: `input "${name}" does not match the required format ${spec.pattern}`,
      };
    }
    if (spec.enum && !spec.enum.includes(value)) {
      return { ok: false, error: `input "${name}" must be one of: ${spec.enum.join(", ")}` };
    }
    if (spec.type === "number" && !Number.isFinite(Number(value))) {
      return { ok: false, error: `input "${name}" must be a number` };
    }
    inputs[name] = spec.type === "number" ? Number(value) : value;
  }

  const unknown = Object.keys(raw).filter((k) => !(k in capability.inputs));
  if (unknown.length > 0) {
    return { ok: false, error: `unknown input(s): ${unknown.join(", ")}` };
  }
  return { ok: true, inputs };
}

function bindPath(
  baseUrl: string,
  template: { path: string; params?: Readonly<Record<string, unknown>> },
  ctx: BindContext,
): { ok: true; url: string } | { ok: false; error: string } {
  let path = template.path;
  for (const [key, source] of Object.entries(template.params ?? {})) {
    const bound = bindValue(source as Parameters<typeof bindValue>[0], ctx);
    if (!bound.ok) return { ok: false, error: `path param "${key}": ${bound.error}` };
    path = path.replace(`{${key}}`, encodeURIComponent(bound.value));
  }
  return { ok: true, url: new URL(path, baseUrl).toString() };
}

function buildEntryUrl(
  baseUrl: string,
  capability: Capability,
  ctx: BindContext,
): { ok: true; url: string } | { ok: false; error: string } {
  return bindPath(baseUrl, capability.app.entry, ctx);
}
