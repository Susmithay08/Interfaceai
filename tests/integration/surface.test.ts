import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createTargetApp } from "../../apps/target-app/server.js";
import { PlaywrightWebSurface } from "../../src/surface/web/playwright-surface.js";
import { ControlLease } from "../../src/session/control-lease.js";
import { FileEvidenceSink } from "../../src/evidence/sink.js";
import { resolveTarget } from "../../src/resolution/resolve-target.js";
import type { ConcreteTargetDescriptor } from "../../src/model/target.js";
import type { Observation, UiNode } from "../../src/model/observation.js";

let server: Server;
let base: string;
let surface: PlaywrightWebSurface;
let lease: ControlLease;

const CONTENT = [{ by: "name" as const, value: "content" }];

beforeAll(async () => {
  server = createTargetApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;

  lease = new ControlLease();
  lease.acquire("automation");
  surface = await PlaywrightWebSurface.launch({
    baseUrl: base,
    headless: true,
    lease,
    evidence: new FileEvidenceSink(mkdtempSync(join(tmpdir(), "surface-"))),
  });
}, 60_000);

afterAll(async () => {
  await surface.dispose();
  await new Promise((r) => server.close(() => r(undefined)));
});

const find = (o: Observation, p: (n: UiNode) => boolean): UiNode | undefined => o.nodes.find(p);

const enterApp = async (): Promise<Observation> => {
  await surface.execute({ kind: "navigate", url: `${base}/teller` });
  return surface.observe();
};

/** Walks the real flow: search form -> results -> member detail, inside the content frame. */
const walkToMemberDetail = async (memberId: string): Promise<Observation> => {
  let o = await enterApp();

  const field = find(o, (n) => n.anchors.some((a) => a.kind === "label" && a.text === "Member ID"))!;
  await surface.execute({ kind: "fill", ref: field.ref, value: memberId });

  o = await surface.observe();
  const search = find(o, (n) => n.role === "button" && n.name === "Search")!;
  await surface.execute({ kind: "click", ref: search.ref });
  await new Promise((r) => setTimeout(r, 250));

  o = await surface.observe();
  const link = find(o, (n) => n.role === "link" && n.name === memberId)!;
  await surface.execute({ kind: "click", ref: link.ref });
  await new Promise((r) => setTimeout(r, 250));

  return surface.observe();
};

describe("perception", () => {
  it("observes labelled controls inside the named content frame", async () => {
    const o = await enterApp();
    const mid = find(o, (n) => n.anchors.some((a) => a.kind === "label" && a.text === "Member ID"));
    expect(mid).toBeDefined();
    expect(mid!.role).toBe("textbox");
    expect(mid!.scope.path).toEqual(CONTENT);
  });

  it("assigns a region from the nearest preceding heading", async () => {
    const o = await enterApp();
    const mid = find(o, (n) => n.anchors.some((a) => a.kind === "label" && a.text === "Member ID"));
    expect(mid!.scope.region).toEqual({ by: "heading", value: "Member Search" });
  });

  it("keeps the nav frame in a separate scope", async () => {
    const o = await enterApp();
    const navLink = find(o, (n) => n.role === "link" && n.name === "Member Search");
    expect(navLink!.scope.path).toEqual([{ by: "name", value: "nav" }]);
  });

  it("produces a stable screenSignature despite incidental wrapper churn", async () => {
    const a = await enterApp();
    const b = await enterApp();
    expect(b.screenSignature).toBe(a.screenSignature);
  });
});

describe("execution", () => {
  it("walks search -> results -> detail by ref", async () => {
    const o = await walkToMemberDetail("100234");
    expect(o.nodes.some((n) => n.value === "$4,182.55")).toBe(true);
  });

  it("exposes table cells with row and column anchors", async () => {
    const o = await walkToMemberDetail("100234");
    const cell = find(
      o,
      (n) =>
        n.role === "cell" &&
        n.anchors.some((a) => a.kind === "rowHeader" && a.text === "Savings") &&
        n.anchors.some((a) => a.kind === "columnHeader" && a.text === "Current Balance"),
    );
    expect(cell).toBeDefined();
    expect(cell!.value).toBe("$4,182.55");
  });

  it("resolves an anchoredCell descriptor against a real observation", async () => {
    const o = await walkToMemberDetail("100234");
    const target: ConcreteTargetDescriptor = {
      scope: { path: CONTENT, region: { by: "heading", value: "Accounts" } },
      expectedRole: "cell",
      primary: {
        kind: "anchoredCell",
        params: { rowKey: "Savings", columnHeader: "Current Balance" },
      },
      fallbacks: [],
      cardinality: "exactlyOne",
      rationale: "Row and column anchoring survives column reordering on a table with no ids.",
    };
    const r = resolveTarget(target, o);
    expect(r.ok).toBe(true);
    if (r.ok) expect(o.nodes.find((n) => n.ref === r.ref)!.value).toBe("$4,182.55");
  });

  it("picks the Savings row, not the Checking row, purely from the row anchor", async () => {
    const o = await walkToMemberDetail("100234");
    const checking: ConcreteTargetDescriptor = {
      scope: { path: CONTENT, region: { by: "heading", value: "Accounts" } },
      expectedRole: "cell",
      primary: {
        kind: "anchoredCell",
        params: { rowKey: "Checking", columnHeader: "Current Balance" },
      },
      fallbacks: [],
      cardinality: "exactlyOne",
      rationale: "Same table, different row anchor - proves the anchor is what selects.",
    };
    const r = resolveTarget(checking, o);
    expect(r.ok).toBe(true);
    if (r.ok) expect(o.nodes.find((n) => n.ref === r.ref)!.value).toBe("$912.10");
  });

  it("rejects a stale ref from a previous observation", async () => {
    const first = await enterApp();
    const someRef = first.nodes[0]!.ref;
    await enterApp();
    await expect(surface.execute({ kind: "click", ref: someRef })).rejects.toThrow(/stale ref/i);
  });
});

describe("control lease enforcement", () => {
  it("refuses to execute while the operator holds the session", async () => {
    const o = await enterApp();
    const ref = o.nodes[0]!.ref;
    lease.transfer("automation", "operator", "test handoff");
    await expect(surface.execute({ kind: "click", ref })).rejects.toThrow(/ControlNotHeld/);
    lease.transfer("operator", "automation", "test handback");
  });
});

describe("evidence capture", () => {
  it("writes a screenshot to the evidence directory", async () => {
    await enterApp();
    const ref = await surface.capture("test-capture");
    expect(ref.kind).toBe("screenshot");
    expect(existsSync(ref.path)).toBe(true);
  });
});
