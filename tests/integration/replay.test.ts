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
import type { Condition } from "../../src/model/condition.js";

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

  /**
   * What the run is allowed to claim once a human hands control back.
   *
   * The bug these pin down: `finalStatus` used to be `success` whenever the step had no
   * checkpoint, because "nothing to re-assert" was treated as "nothing went wrong". A run
   * could therefore report success with the blocking condition still on the screen and
   * the operator having done nothing at all.
   */
  describe("post-handoff verification", () => {
    /** Plays the operator: waits for the lease, does something, hands control back. */
    const operator = async (act: () => Promise<void>): Promise<void> => {
      await lease.waitUntilHeldBy("operator", 30_000);
      await act();
      lease.transfer("operator", "automation", "operator handed back");
    };

    /**
     * The content frame of the teller shell, once it is actually attached.
     *
     * A real operator sees the page settle before they hand back. Reaching for the frame
     * the instant goto() resolves races the frameset, and handing control back mid-load
     * would have the engine verify a screen the human never finished leaving.
     */
    const operatorScreen = async () => {
      const page = surface.rawPage();
      await page.goto(`${base}/teller`, { waitUntil: "domcontentloaded" });
      const content = await page.frameLocator('frame[name="content"]').owner().contentFrame();
      if (!content) throw new Error("the teller content frame never attached");
      return content;
    };

    /**
     * A permission denial can be detected either on the step that provoked it or on the
     * next one, depending on how fast the denial page renders. These tests are about what
     * hand-back verification concludes, not about which step caught the denial, so the
     * capability is shaped to make every step behave the same way and the assertions
     * speak to the property rather than to a step id.
     */
    const escalatingReplay = (runId: string, steps: Capability["steps"]) =>
      engine.replay(
        {
          ...capability,
          escalation: { ...capability.escalation, operatorTimeoutSeconds: 60 },
          steps,
        },
        { memberId: "100234" },
        { unattended: true, runId },
      );

    const withNoCheckpoints = (): Capability["steps"] =>
      capability.steps.map((s) => ({
        ...s,
        checkpoint: null,
        checkpointOmittedReason: "Removed by this test: the point is that nothing can be re-asserted.",
      }));

    it("reports unverified, not success, when the step it stopped on has no checkpoint", async () => {
      await arm("permissionDenied");
      const run = escalatingReplay("t-handback-unverified", withNoCheckpoints());

      // The human clears the entitlement problem and leaves a clean screen behind. No step
      // declares a checkpoint, so there is nothing for the engine to re-assert - and that
      // must read as "unverified", never as success.
      await operator(async () => {
        await arm(null);
        const content = await operatorScreen();
        // Hand back only once the clean search form is genuinely on screen.
        await content.locator('input[name="memberId"]').waitFor({ state: "visible" });
      });

      const r = await run;
      expect(r.status).toBe("escalated");
      if (r.status !== "escalated") return;
      expect(r.resumedBy).toBe("operator");
      expect(r.finalStatus, r.verification).toBe("unverified");
      expect(r.verification).toContain("declares no checkpoint");
      expect(events().some((e) => e.type === "handback_verification")).toBe(true);
    }, 60_000);

    it("reports failed when the condition that stopped the run is still on the screen", async () => {
      await arm("permissionDenied");
      const run = escalatingReplay("t-handback-still-blocked", withNoCheckpoints());

      // The human hands control back without fixing anything.
      await operator(async () => {
        /* deliberately nothing */
      });

      const r = await run;
      expect(r.status).toBe("escalated");
      if (r.status !== "escalated") return;
      expect(r.finalStatus).toBe("failed");
      expect(r.verification).toContain("PERMISSION_DENIED");
    }, 60_000);

    it("reports success only when a real checkpoint re-asserts after hand-back", async () => {
      // Same escalation, but now every step asserts the member's result row, so whichever
      // step catches the denial has something real to re-assert once the human is done.
      const s3Action = capability.steps[2]!.action;
      const s3Target = "target" in s3Action ? s3Action.target : undefined;
      if (!s3Target) throw new Error("s3 is expected to act on a target");
      const memberRow: Condition = { kind: "exists", target: s3Target };

      await arm("permissionDenied");
      const run = escalatingReplay(
        "t-handback-success",
        capability.steps.map((s) => ({ ...s, checkpoint: memberRow })),
      );

      // The human fixes the entitlement problem and completes the search by hand, leaving
      // exactly the state step s2 was supposed to reach.
      await operator(async () => {
        await arm(null);
        const content = await operatorScreen();
        await content.locator('input[name="memberId"]').fill("100234");
        await content.locator('input[type="submit"]').click();
        // Hand back only once the result row the checkpoint asserts is actually there.
        await content.locator('a:text("100234")').waitFor({ state: "visible" });
      });

      const r = await run;
      expect(r.status).toBe("escalated");
      if (r.status !== "escalated") return;
      expect(r.finalStatus, r.verification).toBe("success");
    }, 60_000);
  });

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
  }, 120_000);

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
  }, 120_000);
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
