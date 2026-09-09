import { describe, it, expect } from "vitest";
import { evaluateCondition, matchText } from "../../../src/resolution/evaluate.js";
import { loadObservation } from "../../fixtures/load.js";
import type { ConcreteTargetDescriptor } from "../../../src/model/target.js";

const notice: ConcreteTargetDescriptor = {
  scope: {
    path: [{ by: "name", value: "content" }],
    region: { by: "heading", value: "Search Results" },
  },
  expectedRole: "status",
  primary: { kind: "roleInRegion", params: { region: "Search Results", role: "status" } },
  fallbacks: [],
  cardinality: "exactlyOne",
  rationale: "Server renders the empty-result notice in a status region.",
};

describe("matchText", () => {
  it("is case-insensitive and whitespace-normalizing by default", () => {
    expect(matchText("  No   Matching Member ", { op: "contains", value: "no matching" })).toBe(true);
  });
  it("honours caseSensitive", () => {
    expect(matchText("Abc", { op: "equals", value: "abc", caseSensitive: true })).toBe(false);
  });
  it("supports startsWith and regex", () => {
    expect(matchText("Member: Dana", { op: "startsWith", value: "Member:" })).toBe(true);
    expect(matchText("$4,182.55", { op: "regex", value: "^[$][0-9,]+[.][0-9]{2}$" })).toBe(true);
  });
  it("returns false for undefined rather than throwing", () => {
    expect(matchText(undefined, { op: "contains", value: "x" })).toBe(false);
  });
});

describe("evaluateCondition", () => {
  it("text passes when the matcher matches", () => {
    const r = evaluateCondition(
      { kind: "text", target: notice, match: { op: "contains", value: "No matching member" } },
      loadObservation("not-found"));
    expect(r.passed).toBe(true);
  });

  it("text fails and reports what was observed", () => {
    const r = evaluateCondition(
      { kind: "text", target: notice, match: { op: "contains", value: "Account closed" } },
      loadObservation("not-found"));
    expect(r.passed).toBe(false);
    expect(r.observed).toContain("No matching member");
  });

  it("absent passes when the target does not resolve", () => {
    const r = evaluateCondition({ kind: "absent", target: notice }, loadObservation("member-detail"));
    expect(r.passed).toBe(true);
  });

  it("all requires every leaf; any requires one", () => {
    const o = loadObservation("not-found");
    const yes = { kind: "exists", target: notice } as const;
    const no = { kind: "text", target: notice, match: { op: "equals", value: "zzz" } } as const;
    expect(evaluateCondition({ kind: "all", of: [yes, no] }, o).passed).toBe(false);
    expect(evaluateCondition({ kind: "any", of: [yes, no] }, o).passed).toBe(true);
  });

  it("location matches against locationHint", () => {
    const r = evaluateCondition(
      { kind: "location", match: { op: "contains", value: "/teller/member/" } },
      loadObservation("member-detail"));
    expect(r.passed).toBe(true);
  });

  it("reports an unresolvable target as a failure, never a throw", () => {
    const bad: ConcreteTargetDescriptor = {
      ...notice,
      primary: { kind: "roleAndName", params: { role: "button", name: "Nope" } },
    };
    const r = evaluateCondition({ kind: "exists", target: bad }, loadObservation("member-detail"));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("notFound");
  });
});
