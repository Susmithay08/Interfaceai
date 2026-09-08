import { describe, it, expect } from "vitest";
import { matchStrategy } from "../../../src/resolution/strategies.js";
import { loadObservation } from "../../fixtures/load.js";
import type { ScopePath } from "../../../src/model/observation.js";

const content: ScopePath = { path: [{ by: "name", value: "content" }] };
const accounts: ScopePath = {
  path: [{ by: "name", value: "content" }],
  region: { by: "heading", value: "Accounts" },
};

describe("roleAndName", () => {
  it("matches a button by role and accessible name", () => {
    const o = loadObservation("member-search");
    const hits = matchStrategy(
      { kind: "roleAndName", params: { role: "button", name: "Search" } }, content, o);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.role).toBe("button");
  });

  it("returns every match when the name is ambiguous", () => {
    const o = loadObservation("ambiguous-buttons");
    const hits = matchStrategy(
      { kind: "roleAndName", params: { role: "button", name: "Search" } }, content, o);
    expect(hits).toHaveLength(2);
  });

  it("honours prefix matching", () => {
    const o = loadObservation("member-detail");
    const hits = matchStrategy(
      { kind: "roleAndName", params: { role: "heading", name: "Member:" }, match: "prefix" },
      content, o);
    expect(hits).toHaveLength(1);
  });
});

describe("labelled", () => {
  it("matches a control by its associated label", () => {
    const o = loadObservation("member-search");
    const hits = matchStrategy({ kind: "labelled", params: { label: "Member ID" } }, content, o);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.role).toBe("textbox");
  });
});

describe("anchoredCell", () => {
  it("selects the cell at rowKey x columnHeader", () => {
    const o = loadObservation("member-detail");
    const hits = matchStrategy(
      { kind: "anchoredCell", params: { rowKey: "Savings", columnHeader: "Current Balance" } },
      accounts, o);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.value).toBe("$4,182.55");
  });

  it("returns nothing when the row does not exist", () => {
    const o = loadObservation("member-detail");
    expect(matchStrategy(
      { kind: "anchoredCell", params: { rowKey: "Money Market", columnHeader: "Current Balance" } },
      accounts, o)).toHaveLength(0);
  });
});

describe("roleInRegion", () => {
  it("matches the sole node of a role inside a region", () => {
    const o = loadObservation("member-detail");
    const hits = matchStrategy(
      { kind: "roleInRegion", params: { region: "Accounts", role: "table" } }, content, o);
    expect(hits).toHaveLength(1);
  });
});

describe("scope isolation", () => {
  it("never matches a node in a different frame", () => {
    const o = loadObservation("member-search");
    const nav: ScopePath = { path: [{ by: "name", value: "nav" }] };
    expect(matchStrategy(
      { kind: "roleAndName", params: { role: "button", name: "Search" } }, nav, o)).toHaveLength(0);
  });
});
