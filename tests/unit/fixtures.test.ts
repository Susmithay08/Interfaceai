import { describe, it, expect } from "vitest";
import { loadObservation, FIXTURE_NAMES } from "../fixtures/load.js";

describe("observation fixtures", () => {
  it.each(FIXTURE_NAMES)("%s is a well-formed observation", (name) => {
    const o = loadObservation(name);
    expect(o.nodes.length).toBeGreaterThan(0);
    expect(new Set(o.nodes.map((n) => n.ref)).size).toBe(o.nodes.length);
    for (const n of o.nodes) expect(n.role).toBeTruthy();
  });

  it("member-detail contains an Accounts table with a Savings row", () => {
    const o = loadObservation("member-detail");
    const cells = o.nodes.filter((n) => n.role === "cell");
    expect(
      cells.some((c) => c.anchors.some((a) => a.kind === "rowHeader" && a.text === "Savings")),
    ).toBe(true);
  });

  it("ambiguous-buttons has two identically named Search buttons", () => {
    const o = loadObservation("ambiguous-buttons");
    expect(o.nodes.filter((n) => n.role === "button" && n.name === "Search")).toHaveLength(2);
  });
});
