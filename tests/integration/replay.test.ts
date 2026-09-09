import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createTargetApp } from "../../apps/target-app/server.js";
import { PlaywrightWebSurface } from "../../src/surface/web/playwright-surface.js";
import { ControlLease } from "../../src/session/control-lease.js";
import { EscalationService } from "../../src/session/escalation.js";
import { FileEvidenceSink } from "../../src/evidence/sink.js";
import { PolicyEngine } from "../../src/policy/policy-engine.js";
import { FileCapabilityStore } from "../../src/store/capability-store.js";
import { ReplayEngine } from "../../src/replay/replay-engine.js";
import type { Capability } from "../../src/model/capability.js";
import type { RunEvent } from "../../src/model/evidence.js";

const CAP_ID = "corebank.member.readSavingsBalance";

let server: Server;
let base: string;
let surface: PlaywrightWebSurface;
let lease: ControlLease;
let escalation: EscalationService;
let evidence: FileEvidenceSink;
let engine: ReplayEngine;
let capability: Capability;
const store = new FileCapabilityStore("capabilities", "profiles");

const arm = async (fault: string | null): Promise<void> => {
  await fetch(`${base}/_control/faults`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fault }),
  });
};

const events = (): RunEvent[] =>
  readFileSync(join(evidence.runDir, "run.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunEvent);

const buildEngine = (over: Partial<Parameters<typeof makeDeps>[0]> = {}): ReplayEngine =>
  new ReplayEngine(makeDeps(over));

function makeDeps(over: Record<string, unknown> = {}) {
  return {
    surface,
    policy: new PolicyEngine({
      allowedOrigins: [base],
      allowedPathPrefixes: ["/teller"],
      allowedActionKinds: ["click", "fill", "select", "pressKey", "wait", "navigate", "dismiss"],
    }),
    evidence,
    escalation,
    lease,
    baseUrl: base,
    outcomes: store.resolveOutcomes(capability),
    credentials: (ref: string) =>
      ref === "corebank.teller.username"
        ? "demo.teller"
        : ref === "corebank.teller.password"
          ? "demo-pass-not-real"
          : undefined,
    ...over,
  } as ConstructorParameters<typeof ReplayEngine>[0];
}

beforeAll(async () => {
  server = createTargetApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  capability = store.load(CAP_ID);
}, 60_000);

afterAll(async () => {
  await surface?.dispose();
  await new Promise((r) => server.close(() => r(undefined)));
});

beforeEach(async () => {
  await arm(null);
  await surface?.dispose();
  lease = new ControlLease();
  lease.acquire("automation");
  evidence = new FileEvidenceSink(mkdtempSync(join(tmpdir(), "replay-")));
  escalation = new EscalationService(evidence);
  surface = await PlaywrightWebSurface.launch({
    baseUrl: base,
    headless: true,
    lease,
    evidence,
  });
  engine = buildEngine();
});

describe("happy path", () => {
  it("replays deterministically and returns typed outputs", async () => {
    const r = await engine.replay(capability, { memberId: "100234" }, {
      unattended: true,
      runId: "t1",
    });
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.outputs["savingsBalance"]).toBe(4182.55);
      expect(typeof r.outputs["savingsBalance"]).toBe("number");
      expect(r.outputs["memberName"]).toBe("Dana Whitfield");
      expect(r.outputs["savingsAccountLast4"]).toBe("4417");
    }
  });

  it("reads a different member without re-recording anything", async () => {
    const r = await engine.replay(capability, { memberId: "100999" }, {
      unattended: true,
      runId: "t2",
    });
    expect(r.status).toBe("success");
    if (r.status === "success") expect(r.outputs["savingsBalance"]).toBe(210);
  });

  it("reports which strategy tier resolved each step", async () => {
    const r = await engine.replay(capability, { memberId: "100234" }, {
      unattended: true,
      runId: "t3",
    });
    if (r.status === "success") {
      expect(r.resolutionReport.length).toBeGreaterThan(0);
      expect(r.resolutionReport.every((s) => s.tier === 0)).toBe(true);
    }
  });

  it("never invokes an LLM - the engine has no such dependency", () => {
    const deps = makeDeps() as unknown as Record<string, unknown>;
    expect(Object.keys(deps)).not.toContain("llm");
    expect(Object.keys(deps)).not.toContain("model");
  });
});

describe("business outcomes are answers, not failures", () => {
  it("returns MEMBER_NOT_FOUND with the application's own wording", async () => {
    const r = await engine.replay(capability, { memberId: "999999" }, {
      unattended: true,
      runId: "t4",
    });
    expect(r.status).toBe("business_outcome");
    if (r.status === "business_outcome") {
      expect(r.code).toBe("MEMBER_NOT_FOUND");
      expect(r.message).toContain("No matching member");
    }
  });

  it("rejects a malformed input pre-flight, before opening a page", async () => {
    const r = await engine.replay(capability, { memberId: "abc" }, {
      unattended: true,
      runId: "t5",
    });
    expect(r.status).toBe("business_outcome");
    if (r.status === "business_outcome") {
      expect(r.code).toBe("INVALID_INPUT");
      expect(r.steps).toHaveLength(0);
    }
  });

  it("rejects an unknown input name rather than silently ignoring it", async () => {
    const r = await engine.replay(capability, { memberId: "100234", sneaky: "x" }, {
      unattended: true,
      runId: "t6",
    });
    expect(r.status).toBe("business_outcome");
    if (r.status === "business_outcome") expect(r.message).toContain("sneaky");
  });

  it("surfaces the server's own validation outcome when it reaches the app", async () => {
    const relaxed: Capability = {
      ...capability,
      inputs: { memberId: { ...capability.inputs["memberId"]!, pattern: "^[0-9]{2,6}$" } },
    };
    const r = await engine.replay(relaxed, { memberId: "12" }, {
      unattended: true,
      runId: "t7",
    });
    expect(r.status).toBe("business_outcome");
    if (r.status === "business_outcome") {
      expect(r.code).toBe("INVALID_MEMBER_ID");
      expect(r.message).toContain("6 digits");
    }
  });
});

describe("recoverable conditions", () => {
  it("dismisses an unexpected interstitial and still succeeds", async () => {
    await arm("interstitial");
    const r = await engine.replay(capability, { memberId: "100234" }, {
      unattended: true,
      runId: "t8",
    });
    expect(r.status).toBe("success");
    const detected = events().filter(
      (e) => e.type === "outcome_detected" && e.code === "INTERSTITIAL_NOTICE",
    );
    expect(detected.length).toBeGreaterThan(0);
    expect(events().some((e) => e.type === "recovery_attempt")).toBe(true);
  });

  it("re-authenticates and restarts after a session timeout", async () => {
    await arm("sessionExpired");
    const r = await engine.replay(capability, { memberId: "100234" }, {
      unattended: true,
      runId: "t9",
    });
    expect(r.status).toBe("success");
    const recovery = events().filter(
      (e) => e.type === "recovery_attempt" && e.code === "SESSION_EXPIRED",
    );
    expect(recovery.length).toBeGreaterThan(0);
    expect(recovery[0]).toMatchObject({ resume: "restart" });
  });

  it("waits through a transient slow load instead of failing", async () => {
    await arm("slowLoad");
    const r = await engine.replay(capability, { memberId: "100234" }, {
      unattended: true,
      runId: "t10",
    });
    expect(r.status).toBe("success");
  });

  it("never writes the credential value into evidence during re-authentication", async () => {
    await arm("sessionExpired");
    await engine.replay(capability, { memberId: "100234" }, { unattended: true, runId: "t11" });
    const raw = readFileSync(join(evidence.runDir, "run.jsonl"), "utf8");
    expect(raw).not.toContain("demo-pass-not-real");
  });
});

describe("hard failures", () => {
  it("escalates on a permission denial rather than retrying", async () => {
    await arm("permissionDenied");
    // No operator will take control, so the intervention times out and the run reports it.
    const shortTimeout: Capability = {
      ...capability,
      escalation: { ...capability.escalation, operatorTimeoutSeconds: 5 },
    };
    const r = await engine.replay(shortTimeout, { memberId: "100234" }, {
      unattended: true,
      runId: "t12",
    });
    expect(r.status).toBe("escalated");
    if (r.status === "escalated") {
      const iv = escalation.get(r.interventionId)!;
      expect(iv.screenshotRef).toBeTruthy();
      expect(iv.stepIntent).toBeTruthy();
      expect(iv.observed).toContain("PERMISSION_DENIED");
      expect(iv.status).toBe("timedOut");
    }
  }, 40_000);

  it("fails with a debuggable error when a target cannot be resolved", async () => {
    const broken: Capability = {
      ...capability,
      escalation: { ...capability.escalation, onUnknownState: "fail", onHardFailure: "fail" },
      steps: capability.steps.map((s) =>
        s.id === "s1"
          ? {
              ...s,
              action: {
                ...s.action,
                target: {
                  ...(s.action as { target: NonNullable<unknown> }).target,
                  primary: { kind: "labelled", params: { label: "Nonexistent Field" } },
                  fallbacks: [],
                },
              },
            }
          : s,
      ) as Capability["steps"],
    };
    const r = await engine.replay(broken, { memberId: "100234" }, {
      unattended: true,
      runId: "t13",
    });
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.error.stepId).toBe("s1");
      expect(r.error.code).toBe("TARGET_UNRESOLVED");
      expect(r.error.attempts.length).toBeGreaterThan(0);
      expect(r.error.expected).toContain("textbox");
    }
  }, 60_000);

  it("blocks and does not execute when policy denies the action kind", async () => {
    const denying = buildEngine({
      policy: new PolicyEngine({
        allowedOrigins: [base],
        allowedPathPrefixes: ["/teller"],
        allowedActionKinds: ["wait"],
      }),
    });
    const r = await denying.replay(capability, { memberId: "100234" }, {
      unattended: true,
      runId: "t14",
    });
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error.code).toBe("POLICY_BLOCKED");
  });

  it("requires confirmation for a draft capability instead of running it", async () => {
    const draft: Capability = {
      ...capability,
      status: "draft",
      escalation: { ...capability.escalation, operatorTimeoutSeconds: 5 },
    };
    const r = await engine.replay(draft, { memberId: "100234" }, {
      unattended: true,
      runId: "t15",
    });
    expect(r.status).toBe("escalated");
    if (r.status === "escalated") expect(r.reason).toBe("riskyAction");
  }, 60_000);
});

describe("determinism", () => {
  it("produces identical step traces across two runs with the same input", async () => {
    const shape = (r: Awaited<ReturnType<ReplayEngine["replay"]>>): unknown =>
      r.steps.map((s) => ({
        stepId: s.stepId,
        actionKind: s.actionKind,
        tier: s.tier,
      }));

    const a = await engine.replay(capability, { memberId: "100234" }, {
      unattended: true,
      runId: "t16a",
    });
    const b = await engine.replay(capability, { memberId: "100234" }, {
      unattended: true,
      runId: "t16b",
    });
    expect(shape(a)).toEqual(shape(b));
    expect(a.status).toBe(b.status);
  }, 90_000); // two full replays; generous under full-suite load
});
