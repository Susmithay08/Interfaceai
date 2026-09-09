import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createTargetApp } from "../../apps/target-app/server.js";
import { PlaywrightWebSurface } from "../../src/surface/web/playwright-surface.js";
import { DiscoveryLoop } from "../../src/agent/discovery-loop.js";
import { ReplayEngine } from "../../src/replay/replay-engine.js";
import { ControlLease } from "../../src/session/control-lease.js";
import { EscalationService } from "../../src/session/escalation.js";
import { MemoryEvidenceSink } from "../../src/evidence/sink.js";
import { PolicyEngine, defaultPolicy } from "../../src/policy/policy-engine.js";
import { FileCapabilityStore } from "../../src/store/capability-store.js";
import { parseCapability } from "../../src/model/capability.js";
import { asRef } from "../../src/model/ids.js";
import type {
  AgentDecision,
  DecisionRequest,
  LlmClient,
} from "../../src/agent/llm/llm-client.js";

/**
 * The discovery loop against the REAL browser and the REAL app, with the model replaced by
 * a script. It proves everything the live Groq run depends on - perception, recording,
 * policy, execution - without making the outcome hostage to what a model decides on the
 * day. What the live run adds on top of this is exactly one thing: the decisions.
 */

let server: Server;
let base: string;
let surface: PlaywrightWebSurface;
let evidence: MemoryEvidenceSink;
let lease: ControlLease;

class Scripted implements LlmClient {
  readonly provider = "scripted";
  readonly model = "scripted-live";
  #i = 0;
  constructor(private readonly script: readonly ((r: DecisionRequest) => AgentDecision)[]) {}
  decide(req: DecisionRequest): Promise<AgentDecision> {
    const next = this.script[this.#i++] ?? (() => ({ kind: "stuck", reason: "script exhausted" }));
    return Promise.resolve(next(req));
  }
}

const find = (r: DecisionRequest, p: (n: DecisionRequest["nodes"][number]) => boolean) => {
  const hit = r.nodes.find(p);
  if (!hit) throw new Error("no matching control on the screen");
  return asRef(hit.ref);
};

beforeAll(async () => {
  server = createTargetApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;

  evidence = new MemoryEvidenceSink();
  lease = new ControlLease();
  surface = await PlaywrightWebSurface.launch({ baseUrl: base, headless: true, lease, evidence });
}, 60_000);

afterAll(async () => {
  await surface.dispose();
  await new Promise((r) => server.close(() => r(undefined)));
});

describe("discovery against the live app", () => {
  it("records an artifact that replays, on a different member, with no model", async () => {
    const policy = new PolicyEngine({ ...defaultPolicy(), allowedOrigins: [base] });
    const loop = new DiscoveryLoop({
      surface,
      policy,
      evidence,
      escalation: new EscalationService(evidence),
      lease,
      llm: new Scripted([
        (r) => ({
          kind: "act",
          ref: find(r, (n) => n.anchors.includes("label:Member ID")),
          action: { kind: "fill", inputName: "memberId" },
          rationale: "Enter the member number in the search field.",
        }),
        (r) => ({
          kind: "act",
          ref: find(r, (n) => n.role === "button" && n.name === "Search"),
          action: { kind: "click" },
          rationale: "Submit the member search.",
        }),
        (r) => ({
          kind: "act",
          ref: find(r, (n) => n.role === "link" && n.value === "100234"),
          action: { kind: "click" },
          rationale: "Open the matching member's detail screen.",
        }),
        (r) => ({
          kind: "extract",
          ref: find(
            r,
            (n) =>
              n.anchors.includes("rowHeader:Savings") &&
              n.anchors.includes("columnHeader:Current Balance"),
          ),
          field: "savingsBalance",
          as: "number",
          rationale: "Read the savings row's current balance.",
        }),
        () => ({ kind: "done", summary: "balance read" }),
      ]),
      baseUrl: base,
    });

    const result = await loop.run({
      goal: "look up member 100234 and read their current savings balance",
      inputs: { memberId: "100234" },
      entryPath: "/teller",
      runId: "run_disc_live",
      capabilityId: "test.live.readSavingsBalance",
    });

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") return;

    const capability = parseCapability(result.capability);
    expect(capability.status).toBe("draft");
    expect(capability.steps).toHaveLength(3);

    // The recording is parameterized, not pinned: replay it for a DIFFERENT member.
    const approved = { ...capability, status: "approved" as const };
    const store = new FileCapabilityStore();
    const engine = new ReplayEngine({
      surface,
      policy,
      evidence,
      escalation: new EscalationService(evidence),
      lease,
      baseUrl: base,
      outcomes: store.resolveOutcomes(approved),
      credentials: () => undefined,
    });

    lease.acquire("automation", "replay after discovery");
    const replayed = await engine.replay(
      approved,
      { memberId: "100999" },
      // A short operator timeout so an unexpected escalation fails the test instead of hanging it.
      { unattended: true, runId: "run_replay_after_discovery", operatorTimeoutSeconds: 5 },
    );

    expect(replayed.status, JSON.stringify(replayed).slice(0, 400)).toBe("success");
    if (replayed.status !== "success") return;
    expect(replayed.outputs["savingsBalance"]).toBe(210);
  }, 90_000);
});
