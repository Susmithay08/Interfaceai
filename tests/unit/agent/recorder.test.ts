import { describe, expect, it } from "vitest";
import { describeTarget, finalizeCapability } from "../../../src/agent/recorder.js";
import { resolveTarget } from "../../../src/resolution/resolve-target.js";
import { bindTarget } from "../../../src/resolution/bind.js";
import { parseCapability } from "../../../src/model/capability.js";
import type { Observation } from "../../../src/model/observation.js";
import { asRef } from "../../../src/model/ids.js";
import { FIXTURE_NAMES, loadObservation, refOf } from "../../fixtures/load.js";

const NO_VALUES = { inputs: {}, outputs: {}, credentials: () => undefined };

describe("describeTarget", () => {
  it("self-validates: every descriptor it emits resolves back to the same ref, uniquely", () => {
    for (const name of FIXTURE_NAMES) {
      const o = loadObservation(name);
      for (const node of o.nodes) {
        const t = describeTarget(node.ref, o);
        if (!t) continue;
        const bound = bindTarget(t, NO_VALUES);
        expect(bound.ok).toBe(true);
        if (!bound.ok) continue;
        const r = resolveTarget(bound.target, o);
        expect(r.ok && r.ref === node.ref, `${name}/${node.ref} did not resolve back`).toBe(true);
      }
    }
  });

  it("returns null for a ref that is not on the screen", () => {
    expect(describeTarget(asRef("nope"), loadObservation("member-detail"))).toBeNull();
  });

  it("prefers an explicit label for a labelled control", () => {
    const o = loadObservation("member-search");
    const t = describeTarget(refOf(o, (n) => n.role === "textbox"), o);
    expect(t?.primary.kind).toBe("labelled");
    expect(t?.primary.params["label"]).toBe("Member ID");
  });

  it("prefers row-by-column anchoring for a table cell", () => {
    const o = loadObservation("member-detail");
    const balance = refOf(
      o,
      (n) => n.role === "cell" && n.anchors.some((a) => a.text === "Current Balance"),
    );
    const t = describeTarget(balance, o);
    expect(t?.primary.kind).toBe("anchoredCell");
    expect(t?.primary.params).toMatchObject({ rowKey: "Savings", columnHeader: "Current Balance" });
  });

  it("records verified fallbacks alongside the primary", () => {
    const o = loadObservation("member-search");
    const t = describeTarget(refOf(o, (n) => n.role === "button"), o);
    expect(t?.fallbacks.length).toBeGreaterThan(0);
    for (const f of t!.fallbacks) expect(f).not.toEqual(t!.primary);
  });

  it("disambiguates two identically named controls by their region", () => {
    const o = loadObservation("ambiguous-buttons");
    const [a, b] = o.nodes;
    const ta = describeTarget(a!.ref, o)!;
    const tb = describeTarget(b!.ref, o)!;
    expect(ta.scope.region?.value).toBe("Member Search");
    expect(tb.scope.region?.value).toBe("Account Search");
  });

  it("returns null when no strategy can single out the node", () => {
    expect(describeTarget(asRef("n2"), twinButtons())).toBeNull();
  });

  // Regression: the live discovery run recorded the balance cell with the observed
  // amount as a fallback locator, twice over. Both halves of that are fixed here.
  it("never locates a cell by the value it is carrying", () => {
    const t = describeTarget(asRef("n1"), balanceCell())!;
    const asText = JSON.stringify(t);
    expect(t.primary.kind).toBe("anchoredCell");
    expect(asText, "the balance must not appear anywhere in the descriptor").not.toContain(
      "4,182.55",
    );
    for (const f of t.fallbacks) expect(f.kind).not.toBe("roleAndName");
  });

  // The guard above must not swallow the ordinary case: the browser reports a link's
  // name and its text as the same string too, and there the name is the identity.
  it("still targets a link by its name, parameterized to the input it matches", () => {
    const o = loadObservation("search-results");
    const link = o.nodes.find((n) => n.role === "link" && n.value === "100234");
    if (!link) return;
    const t = describeTarget(link.ref, o, { memberId: "100234" })!;
    expect(JSON.stringify(t)).toContain('"from":"input"');
  });

  it("records no fallback twice", () => {
    for (const name of FIXTURE_NAMES) {
      const o = loadObservation(name);
      for (const node of o.nodes) {
        const t = describeTarget(node.ref, o);
        if (!t) continue;
        const written = [t.primary, ...t.fallbacks].map((s) => JSON.stringify(s));
        expect(new Set(written).size, `${name}/${node.ref} recorded a duplicate locator`).toBe(
          written.length,
        );
      }
    }
  });

  it("parameterizes a param that equals a supplied input value", () => {
    const o = loadObservation("search-results");
    const t = describeTarget(refOf(o, (n) => n.value === "100234"), o, { memberId: "100234" })!;
    expect(t.primary.kind).toBe("anchoredCell");
    expect(t.primary.params["rowKey"]).toEqual({ from: "input", name: "memberId" });
    // The column header is not run-specific, so it stays a literal.
    expect(t.primary.params["columnHeader"]).toBe("Member");
  });

  it("the parameterized descriptor serves another member without re-recording", () => {
    const o = loadObservation("search-results");
    const t = describeTarget(refOf(o, (n) => n.value === "100234"), o, { memberId: "100234" })!;
    const bound = bindTarget(t, { ...NO_VALUES, inputs: { memberId: "100999" } });
    expect(bound.ok).toBe(true);
    const r = bound.ok ? resolveTarget(bound.target, o) : null;
    expect(r?.ok && r.ref).toBe(refOf(o, (n) => n.value === "100999"));
  });

  it("rejects a region that merely contains an input value", () => {
    const t = describeTarget(asRef("n1"), dataDependentRegion(), {
      memberName: "Dana Whitfield",
    })!;
    expect(t.scope.region).toBeUndefined();
  });

  it("rejects a name that merely contains an input value", () => {
    const o = loadObservation("member-detail");
    const t = describeTarget(refOf(o, (n) => n.role === "heading"), o, {
      memberName: "Dana Whitfield",
    })!;
    // "Member: Dana Whitfield" is data-dependent, so name-based targeting is not recorded.
    expect(t.primary.kind).not.toBe("roleAndName");
  });
});

describe("finalizeCapability", () => {
  it("emits a draft artifact that parseCapability accepts", () => {
    const c = parseCapability(sampleArgs());
    expect(c.status).toBe("draft");
    expect(c.provenance.generatedBy).toBe("llm-discovery");
    expect(c.outcomes).toEqual([]);
  });

  it("derives risk from what the recorded actions do, and lists weak targets for review", () => {
    const c = parseCapability(sampleArgs());
    expect(c.risk).toBe("reversible");
    expect(c.review.weakTargets).toEqual([]);
    expect(c.review.notes).toMatch(/human review/i);
  });

  it("checkpoints each step against the control the next step needs", () => {
    const c = parseCapability(sampleArgs());
    expect(c.steps[0]!.checkpoint).not.toBeNull();
    const last = c.steps.at(-1)!;
    expect(last.checkpoint === null ? last.checkpointOmittedReason : "ok").toBeTruthy();
  });

  it("declares a currency transform for a number output read from a dollar amount", () => {
    const c = parseCapability(sampleArgs());
    expect(c.outputs["savingsBalance"]!.type).toBe("number");
    expect(c.outputs["savingsBalance"]!.transform).toContainEqual({
      kind: "currencyToNumber",
      currency: "USD",
    });
    expect(c.outputs["savingsBalance"]!.sensitivity).toBe("financial");
  });
});

/* ── helpers ──────────────────────────────────────────────────────────── */

function sampleArgs() {
  const search = loadObservation("member-search");
  const detail = loadObservation("member-detail");
  const field = describeTarget(refOf(search, (n) => n.role === "textbox"), search)!;
  const button = describeTarget(refOf(search, (n) => n.role === "button"), search)!;
  const balance = describeTarget(
    refOf(detail, (n) => n.role === "cell" && n.anchors.some((a) => a.text === "Current Balance")),
    detail,
  )!;

  return finalizeCapability({
    id: "test.member.readBalance",
    title: "Read savings balance",
    description: "Looks up a member and reads their savings balance.",
    goal: "read the savings balance for a member",
    entryPath: "/teller",
    entryCheckpoint: { kind: "exists", target: field },
    inputs: {
      memberId: {
        type: "string",
        description: "Member number.",
        required: true,
        sensitivity: "identifier",
        example: "100234",
      },
    },
    steps: [
      {
        action: { kind: "fill", target: field, value: { from: "input", name: "memberId" } },
        rationale: "Enter the member number in the search field.",
        provenance: "llm",
      },
      { action: { kind: "click", target: button }, rationale: "Run the search.", provenance: "llm" },
    ],
    outputs: [
      {
        field: "savingsBalance",
        as: "number",
        target: balance,
        sampleValue: "$4,182.55",
        afterStepId: "s2",
      },
    ],
    successCheckpoint: { kind: "exists", target: balance },
    provider: "test",
    model: "test-model",
    runId: "run_test",
    evidenceRunRef: "evidence/run_test",
  });
}

const CONTENT = [{ by: "name" as const, value: "content" }];

/** Two indistinguishable controls in one region: nothing can single either one out. */
/**
 * A balance cell as the real browser reports it: the accessible name of a table cell is
 * its own text, so name and value are the same string. The fixtures carry a value and no
 * name, which is why this case only showed up against the live surface.
 */
function balanceCell(): Observation {
  return {
    observationId: "balance",
    surfaceKind: "web",
    screenSignature: "balance",
    nodes: [
      {
        ref: asRef("n1"),
        role: "cell",
        name: "$4,182.55",
        value: "$4,182.55",
        state: { visible: true },
        scope: { path: CONTENT, region: { by: "heading" as const, value: "Accounts" } },
        anchors: [
          { kind: "rowHeader" as const, text: "Savings" },
          { kind: "columnHeader" as const, text: "Current Balance" },
        ],
      },
    ],
    capturedAt: "2026-01-01T00:00:00.000Z",
  };
}

function twinButtons(): Observation {
  const node = (ref: string) => ({
    ref: asRef(ref),
    role: "button",
    state: { visible: true },
    scope: { path: CONTENT, region: { by: "heading" as const, value: "Actions" } },
    anchors: [],
  });
  return {
    observationId: "twin",
    surfaceKind: "web",
    screenSignature: "twin",
    nodes: [node("n1"), node("n2")],
    capturedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** A region title built from run data - recording it would pin the capability to one member. */
function dataDependentRegion(): Observation {
  return {
    observationId: "ddr",
    surfaceKind: "web",
    screenSignature: "ddr",
    nodes: [
      {
        ref: asRef("n1"),
        role: "textbox",
        state: { visible: true },
        scope: { path: CONTENT, region: { by: "heading", value: "Member: Dana Whitfield" } },
        anchors: [{ kind: "label", text: "Nickname" }],
      },
    ],
    capturedAt: "2026-01-01T00:00:00.000Z",
  };
}
