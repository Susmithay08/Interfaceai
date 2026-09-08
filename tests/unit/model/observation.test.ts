import { describe, it, expect } from "vitest";
import { scopeKey, sameScope } from "../../../src/model/observation.js";
import type { ScopePath } from "../../../src/model/observation.js";

const content: ScopePath = { path: [{ by: "name", value: "content" }] };
const accounts: ScopePath = {
  path: [{ by: "name", value: "content" }],
  region: { by: "heading", value: "Accounts" },
};

describe("scopeKey", () => {
  it("is stable and distinguishes region", () => {
    expect(scopeKey(content)).toBe("name:content");
    expect(scopeKey(accounts)).toBe("name:content|region:heading:Accounts");
  });
});

describe("sameScope", () => {
  it("treats a node in a region as inside the region-less parent scope", () => {
    expect(sameScope(accounts, content)).toBe(true);
  });

  it("rejects a node outside the required region", () => {
    expect(sameScope(content, accounts)).toBe(false);
  });

  it("rejects a different frame", () => {
    const nav: ScopePath = { path: [{ by: "name", value: "nav" }] };
    expect(sameScope(nav, content)).toBe(false);
  });
});
