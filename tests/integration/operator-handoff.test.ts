import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "node:http";
import { createTargetApp } from "../../apps/target-app/server.js";
import { PlaywrightWebSurface } from "../../src/surface/web/playwright-surface.js";
import { ControlLease } from "../../src/session/control-lease.js";
import { OperatorHandoff } from "../../src/session/operator-handoff.js";
import { EscalationService } from "../../src/session/escalation.js";
import { MemoryEvidenceSink } from "../../src/evidence/sink.js";
import { createOperatorConsole } from "../../apps/operator-console/server.js";
import { ControlNotHeldError } from "../../src/model/escalation.js";

let appServer: Server;
let base: string;
let surface: PlaywrightWebSurface;
let lease: ControlLease;
let evidence: MemoryEvidenceSink;
let handoff: OperatorHandoff;
let escalation: EscalationService;

beforeAll(async () => {
  appServer = createTargetApp().listen(0);
  await new Promise((r) => appServer.once("listening", r));
  base = `http://localhost:${(appServer.address() as AddressInfo).port}`;

  evidence = new MemoryEvidenceSink();
  lease = new ControlLease();
  escalation = new EscalationService(evidence);
  surface = await PlaywrightWebSurface.launch({ baseUrl: base, headless: true, lease, evidence });
  handoff = new OperatorHandoff({ lease, surface, evidence });

  lease.acquire("automation", "test run");
  await surface.execute({ kind: "navigate", url: `${base}/teller` });
}, 60_000);

afterAll(async () => {
  await surface.dispose();
  await new Promise((r) => appServer.close(() => r(undefined)));
});

describe("operator handoff", () => {
  it("hands the SAME live session to a human and takes it back", async () => {
    const contextBefore = surface.contextId();
    const observation = await surface.observe();
    const searchButton = observation.nodes.find(
      (n) => n.role === "button" && n.name === "Search",
    )!;
    expect(searchButton).toBeDefined();

    // 1. A human takes control of the run automation was driving.
    await handoff.take("operator stepped in");
    expect(lease.holder()).toBe("operator");

    // 2. While they hold it, automation physically cannot act on the page.
    await expect(surface.execute({ kind: "click", ref: searchButton.ref })).rejects.toBeInstanceOf(
      ControlNotHeldError,
    );

    // 3. What the human does is recorded, not an unexplained gap in the run.
    const content = surface.rawPage().frame({ name: "content" })!;
    await content.fill('input[name="memberId"]', "100234");
    await content.click('input[type="submit"]');
    await content.waitForLoadState("domcontentloaded");

    // 4. Control comes back, and it is the same browser context throughout - same
    //    cookies, same session, the page left exactly where the human left it.
    await handoff.release("operator finished the step");
    expect(lease.holder()).toBe("automation");
    expect(surface.contextId()).toBe(contextBefore);

    const transfers = evidence.events.filter((e) => e.type === "control_transfer");
    expect(transfers.map((t) => `${t.from}->${t.to}`)).toEqual([
      "automation->operator",
      "operator->automation",
    ]);

    const humanActions = evidence.events.filter((e) => e.type === "human_action");
    expect(humanActions.length).toBeGreaterThan(0);
    expect(humanActions.some((h) => h.actionKind === "click" || h.actionKind === "submit")).toBe(
      true,
    );

    // 5. Automation resumes against whatever state the human left behind.
    const after = await surface.observe();
    expect(after.nodes.some((n) => n.value === "100234" || n.name === "100234")).toBe(true);
  }, 60_000);

  it("never lets a human's typed value reach evidence in the clear", () => {
    const values = evidence.events
      .filter((e) => e.type === "human_action")
      .map((e) => e.value ?? "");
    for (const v of values) expect(v).not.toMatch(/\d{9,}/);
  });
});

describe("operator console", () => {
  it("serves the queue and drives the lease through take and release", async () => {
    const iv = escalation.raise({
      runId: "run_console_test",
      mode: "replay",
      goal: "read a savings balance",
      reason: "targetUnresolved",
      observed: "the balance cell was not on the screen",
      resumePlan: { resumeAtStepId: "s3", mode: "retryStep" },
    });

    const server = createOperatorConsole({ escalation, handoff }).listen(0);
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    const url = (p: string) => `http://localhost:${port}${p}`;

    try {
      const queue = await get(url("/"));
      expect(queue.body).toContain(iv.id);
      expect(queue.body).toContain("Operator queue");

      const detail = await get(url(`/interventions/${iv.id}`));
      expect(detail.body).toContain("the balance cell was not on the screen");
      expect(detail.body).toContain("Take control");

      const taken = await post(url(`/interventions/${iv.id}/take`));
      expect(taken.status).toBe(302);
      expect(lease.holder()).toBe("operator");
      expect(escalation.get(iv.id)!.status).toBe("in_progress");

      const released = await post(url(`/interventions/${iv.id}/release`), "note=did+it+by+hand");
      expect(released.status).toBe(302);
      expect(lease.holder()).toBe("automation");
      expect(escalation.get(iv.id)!.status).toBe("resolved");
      expect(escalation.get(iv.id)!.resolutionNote).toBe("did it by hand");
    } finally {
      await new Promise((r) => server.close(() => r(undefined)));
    }
  }, 30_000);
});

/* ── tiny HTTP helpers, so the console is exercised over the wire ───────── */

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => (body += String(c)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

function post(url: string, body = ""): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += String(c)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
