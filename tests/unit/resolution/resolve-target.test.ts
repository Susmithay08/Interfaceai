import { describe, it, expect } from "vitest";
import { resolveTarget } from "../../../src/resolution/resolve-target.js";
import { loadObservation } from "../../fixtures/load.js";
import type { TargetDescriptor } from "../../../src/model/target.js";

const content = { path: [{ by: "name" as const, value: "content" }] };

const searchButton = (over: Partial<TargetDescriptor> = {}): TargetDescriptor => ({
  scope: content,
  expectedRole: "button",
  primary: { kind: "roleAndName", params: { role: "button", name: "Search" } },
  fallbacks: [],
  cardinality: "exactlyOne",
  rationale: "Sole submit control in the search region.",
  ...over,
});

describe("resolveTarget", () => {
  it("resolves via the primary strategy and reports tier 0", () => {
    const r = resolveTarget(searchButton(), loadObservation("member-search"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tier).toBe(0);
      expect(r.attempts).toHaveLength(1);
    }
  });

  it("falls through to a fallback and reports the tier that matched", () => {
    const t = searchButton({
      primary: { kind: "roleAndName", params: { role: "button", name: "Find Member" } },
      fallbacks: [{ kind: "roleInRegion", params: { region: "Member Search", role: "button" } }],
    });
    const r = resolveTarget(t, loadObservation("member-search"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tier).toBe(1);
      expect(r.attempts[0]!.outcome).toBe("noMatch");
    }
  });

  it("returns ambiguous rather than picking arbitrarily", () => {
    const r = resolveTarget(searchButton(), loadObservation("ambiguous-buttons"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("ambiguous");
      expect(r.matchCount).toBe(2);
    }
  });

  it("selects deterministically under cardinality:nth", () => {
    const r = resolveTarget(
      searchButton({ cardinality: "nth", nth: 1 }), loadObservation("ambiguous-buttons"));
    expect(r.ok).toBe(true);
  });

  it("reports roleMismatch when the strategy matches the wrong role", () => {
    const t = searchButton({
      expectedRole: "link",
      primary: { kind: "roleAndName", params: { role: "button", name: "Search" } },
    });
    const r = resolveTarget(t, loadObservation("member-search"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("roleMismatch");
  });

  it("returns notFound with every attempt recorded when nothing matches", () => {
    const t = searchButton({
      primary: { kind: "roleAndName", params: { role: "button", name: "Nope" } },
      fallbacks: [{ kind: "roleAndName", params: { role: "button", name: "Also nope" } }],
    });
    const r = resolveTarget(t, loadObservation("member-search"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("notFound");
      expect(r.attempts).toHaveLength(2);
    }
  });

  it("is deterministic - identical inputs give identical results", () => {
    const o = loadObservation("member-search");
    const t = searchButton();
    expect(JSON.stringify(resolveTarget(t, o))).toBe(JSON.stringify(resolveTarget(t, o)));
  });

  it("ignores invisible nodes", () => {
    const o = loadObservation("member-search");
    const hidden = {
      ...o,
      nodes: o.nodes.map((n) => ({ ...n, state: { ...n.state, visible: false } })),
    };
    expect(resolveTarget(searchButton(), hidden).ok).toBe(false);
  });

  it("lets a narrower fallback disambiguate what the primary could not", () => {
    const t = searchButton({
      fallbacks: [{ kind: "roleInRegion", params: { region: "Account Search", role: "button" } }],
    });
    const r = resolveTarget(t, loadObservation("ambiguous-buttons"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tier).toBe(1);
  });
});
