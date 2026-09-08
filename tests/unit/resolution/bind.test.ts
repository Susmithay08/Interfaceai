import { describe, it, expect } from "vitest";
import { bindValue } from "../../../src/resolution/bind.js";

const ctx = {
  inputs: { memberId: "100234" },
  outputs: { memberName: "Dana Whitfield" },
  credentials: (ref: string) => (ref === "corebank.teller.password" ? "s3cret" : undefined),
};

describe("bindValue", () => {
  it("binds an input", () =>
    expect(bindValue({ from: "input", name: "memberId" }, ctx)).toEqual({ ok: true, value: "100234" }));
  it("binds a literal", () =>
    expect(bindValue({ from: "literal", value: "Savings" }, ctx)).toEqual({ ok: true, value: "Savings" }));
  it("binds an earlier output", () =>
    expect(bindValue({ from: "output", name: "memberName" }, ctx))
      .toEqual({ ok: true, value: "Dana Whitfield" }));
  it("binds a credential from the runtime resolver", () =>
    expect(bindValue({ from: "credential", ref: "corebank.teller.password" }, ctx))
      .toEqual({ ok: true, value: "s3cret" }));
  it("fails when an input is missing, naming it", () => {
    const r = bindValue({ from: "input", name: "nope" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("nope");
  });
  it("fails when a credential is not configured", () =>
    expect(bindValue({ from: "credential", ref: "absent" }, ctx).ok).toBe(false));
});
