import { describe, expect, it } from "vitest";
import { DiscoveryLoop, type DiscoveryDeps } from "../../../src/agent/discovery-loop.js";
import { parseCapability } from "../../../src/model/capability.js";
import type { ResolvedAction } from "../../../src/model/action.js";
import type { Observation } from "../../../src/model/observation.js";
import type { EvidenceRef } from "../../../src/model/evidence.js";
import type { Surface } from "../../../src/surface/surface.js";
import { MemoryEvidenceSink } from "../../../src/evidence/sink.js";
import { PolicyEngine, defaultPolicy } from "../../../src/policy/policy-engine.js";
import { ControlLease } from "../../../src/session/control-lease.js";
import { EscalationService } from "../../../src/session/escalation.js";
import type {
  AgentDecision,
  DecisionRequest,
  LlmClient,
  ProposedAction,
} from "../../../src/agent/llm/llm-client.js";
import { asRef } from "../../../src/model/ids.js";
import { loadObservation } from "../../fixtures/load.js";

const BASE = "http://localhost:4000";
const GOAL = "read the savings balance for a member";

/* ── doubles ─────────────────────────────────────────────────────────────
 * A scripted client and a scripted surface: no network, no browser, so every
 * bound in the loop is testable deterministically.
 */

class ScriptedClient implements LlmClient {
  readonly provider = "scripted";
  readonly model = "scripted-1";
  readonly seen: DecisionRequest[] = [];
  #i = 0;

  constructor(private readonly script: readonly ((r: DecisionRequest) => AgentDecision)[]) {}

  decide(req: DecisionRequest): Promise<AgentDecision> {
    this.seen.push(req);
    const next = this.script[this.#i++] ?? (() => ({ kind: "stuck", reason: "script exhausted" }));
    return Promise.resolve(next(req));
  }
}

class ScriptedSurface implements Surface {
  readonly kind = "web" as const;
  readonly executed: ResolvedAction[] = [];
  #i = 0;

  constructor(private readonly screens: readonly Observation[]) {}

  observe(): Promise<Observation> {
    return Promise.resolve(this.screens[Math.min(this.#i, this.screens.length - 1)]!);
  }

  execute(action: ResolvedAction): Promise<void> {
    this.executed.push(action);
    if (action.kind !== "navigate") this.#i++;
    return Promise.resolve();
  }

  capture(reason: string): Promise<EvidenceRef> {
    return Promise.resolve({ kind: "screenshot", path: `:memory:/${reason}.png` });
  }

  instrument(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

function harness(script: readonly ((r: DecisionRequest) => AgentDecision)[], screens?: Observation[]) {
  const evidence = new MemoryEvidenceSink();
  const surface = new ScriptedSurface(screens ?? happyPath());
  const llm = new ScriptedClient(script);
  const deps: DiscoveryDeps = {
    surface,
    llm,
    evidence,
    policy: new PolicyEngine(defaultPolicy()),
    escalation: new EscalationService(),
    lease: new ControlLease(),
    baseUrl: BASE,
  };
  return { deps, evidence, surface, llm, loop: new DiscoveryLoop(deps) };
}

const OPTS = {
  goal: GOAL,
  inputs: { memberId: "100234" },
  entryPath: "/teller",
  runId: "run_disc_test",
  capabilityId: "test.discovered.readBalance",
};

// The search screen appears twice: filling the field does not navigate away from it.
const happyPath = (): Observation[] => [
  loadObservation("member-search"),
  loadObservation("member-search"),
  loadObservation("search-results"),
  loadObservation("member-detail"),
];

/** The scripted equivalent of a model that solves the task. */
const successScript = [
  (r: DecisionRequest) => act(pick(r, "textbox"), { kind: "fill", inputName: "memberId" }),
  (r: DecisionRequest) => act(pick(r, "button"), { kind: "click" }),
  (r: DecisionRequest) => act(pick(r, "link", "100234"), { kind: "click" }),
  (r: DecisionRequest) => extract(pickCell(r, "Current Balance"), "savingsBalance", "number"),
  () => ({ kind: "done", summary: "balance read" }) as AgentDecision,
];

describe("DiscoveryLoop", () => {
  it("records a replayable draft capability from a successful run", async () => {
    const { loop, surface } = harness(successScript);
    const result = await loop.run(OPTS);

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;

    const c = parseCapability(result.capability);
    expect(c.status).toBe("draft");
    expect(c.steps.map((s) => s.action.kind)).toEqual(["fill", "click", "click"]);
    expect(Object.keys(c.outputs)).toEqual(["savingsBalance"]);
    expect(c.provenance.provider).toBe("scripted");
    // Navigate to entry, then one surface action per recorded step.
    expect(surface.executed[0]).toEqual({ kind: "navigate", url: `${BASE}/teller` });
    expect(surface.executed).toHaveLength(4);
  });

  it("binds the live input value at the surface but records only a reference to it", async () => {
    const { loop, surface } = harness(successScript);
    await loop.run(OPTS);

    const fill = surface.executed.find((a) => a.kind === "fill");
    expect(fill).toMatchObject({ value: "100234" });
  });

  it("parameterizes the result row, so the recording is not pinned to one member", async () => {
    const { loop } = harness(successScript);
    const result = await loop.run(OPTS);
    if (result.status !== "recorded") throw new Error("expected a recording");

    const rowClick = result.capability.steps[2]!.action;
    if (rowClick.kind !== "click") throw new Error("expected the row click to be recorded");
    expect(rowClick.target.primary.params["rowKey"]).toEqual({ from: "input", name: "memberId" });
  });

  it("re-prompts with a note when a chosen control cannot be described durably", async () => {
    const screens = [withTwins(loadObservation("member-search")), ...happyPath().slice(1)];
    const { loop, llm } = harness(
      [
        () => act(asRef("t2"), { kind: "click" }), // indistinguishable twin: not recordable
        ...successScript,
      ],
      screens,
    );
    const result = await loop.run(OPTS);

    expect(result.status).toBe("recorded");
    const noted = llm.seen[1]!.history.at(-1)?.note ?? "";
    expect(noted).toMatch(/cannot be recorded/);
  });

  it("feeds a policy denial back as a note instead of failing the run", async () => {
    const deniedPolicy = new PolicyEngine({ ...defaultPolicy(), allowedActionKinds: ["click"] });
    const fill = (r: DecisionRequest) => act(pick(r, "textbox"), { kind: "fill", inputName: "memberId" });
    const { deps, llm } = harness([fill, fill]);
    const loop = new DiscoveryLoop({ ...deps, policy: deniedPolicy });

    const result = await loop.run(OPTS);
    // The fill is refused; the model is told why rather than the run dying.
    const notes = llm.seen.flatMap((s) => s.history.map((h) => h.note ?? ""));
    expect(notes.some((n) => /policy refused/.test(n))).toBe(true);
    expect(result.status).not.toBe("recorded");
  });

  it("escalates when the model reports it is stuck", async () => {
    const { loop, deps } = harness([() => ({ kind: "stuck", reason: "no search field here" })]);
    const result = await loop.run(OPTS);

    expect(result.status).toBe("escalated");
    if (result.status !== "escalated") return;
    expect(result.reason).toBe("agentStuck");
    expect(result.detail).toBe("no search field here");
    // Control is ceded, so automation physically cannot keep acting.
    expect(deps.lease.holder()).toBe("operator");
  });

  it("escalates on no progress rather than looping on an unchanged screen", async () => {
    const stuckScreens = [loadObservation("member-search")];
    const clickButton = (r: DecisionRequest) => act(pick(r, "button"), { kind: "click" });
    const { loop } = harness([clickButton, clickButton, clickButton, clickButton], stuckScreens);

    const result = await loop.run({ ...OPTS, noProgressLimit: 2 });
    expect(result.status).toBe("escalated");
    if (result.status === "escalated") expect(result.reason).toBe("noProgress");
  });

  it("stops at maxSteps and escalates rather than running forever", async () => {
    const { loop } = harness(successScript);
    const result = await loop.run({ ...OPTS, maxSteps: 2 });

    expect(result.status).toBe("escalated");
    if (result.status === "escalated") expect(result.reason).toBe("maxSteps");
  });

  it("will not accept done before anything has been extracted", async () => {
    const { loop, llm } = harness([
      () => ({ kind: "done", summary: "all finished" }),
      ...successScript,
    ]);
    const result = await loop.run(OPTS);

    expect(result.status).toBe("recorded");
    expect(llm.seen[1]!.history.at(-1)?.note).toMatch(/extracted no value/);
  });

  it("shows the model financial figures only in redacted form", async () => {
    const { loop, llm } = harness(successScript);
    await loop.run(OPTS);

    const values = llm.seen.flatMap((r) => r.nodes.map((n) => n.value ?? ""));
    expect(values.some((v) => v === "[FINANCIAL]")).toBe(true);
    expect(values.some((v) => /4,?182\.55/.test(v))).toBe(false);
  });

  it("logs every model decision and policy verdict to evidence", async () => {
    const { loop, evidence } = harness(successScript);
    await loop.run(OPTS);

    const types = evidence.events.map((e) => e.type);
    expect(types).toContain("llm_decision");
    expect(types).toContain("policy_verdict");
    expect(types).toContain("observation");
    expect(types).toContain("extraction");
    expect(types.at(-1)).toBe("run_finished");
  });

  it("blocks an entry outside the allowlist before a page is opened", async () => {
    const { deps } = harness(successScript);
    const loop = new DiscoveryLoop({ ...deps, baseUrl: "http://evil.example" });

    const result = await loop.run(OPTS);
    expect(result.status).toBe("escalated");
    if (result.status === "escalated") expect(result.reason).toBe("policyRequiresConfirmation");
    expect((deps.surface as ScriptedSurface).executed).toHaveLength(0);
  });
});

/* ── scripting helpers ──────────────────────────────────────────────────── */

const act = (ref: string, action: ProposedAction): AgentDecision => ({
  kind: "act",
  ref: asRef(ref),
  action,
  rationale: `act on ${ref}`,
});

const extract = (ref: string, field: string, as: "string" | "number"): AgentDecision => ({
  kind: "extract",
  ref: asRef(ref),
  field,
  as,
  rationale: `read ${field}`,
});

function pick(r: DecisionRequest, role: string, value?: string): string {
  const hit = r.nodes.find((n) => n.role === role && (value === undefined || n.value === value));
  if (!hit) throw new Error(`scripted client found no ${role} on the screen`);
  return hit.ref;
}

function pickCell(r: DecisionRequest, columnHeader: string): string {
  const hit = r.nodes.find(
    (n) => n.role === "cell" && n.anchors.includes(`columnHeader:${columnHeader}`),
  );
  if (!hit) throw new Error(`scripted client found no cell under ${columnHeader}`);
  return hit.ref;
}

/** Adds two indistinguishable controls: the recorder can describe neither of them. */
function withTwins(o: Observation): Observation {
  const twin = (ref: string) => ({
    ref: asRef(ref),
    role: "button",
    state: { visible: true },
    scope: {
      path: [{ by: "name" as const, value: "content" }],
      region: { by: "heading" as const, value: "Actions" },
    },
    anchors: [],
  });
  return { ...o, nodes: [...o.nodes, twin("t1"), twin("t2")] };
}
