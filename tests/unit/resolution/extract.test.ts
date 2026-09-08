import { describe, it, expect } from "vitest";
import { applyTransforms } from "../../../src/resolution/extract.js";

describe("applyTransforms", () => {
  it("converts USD currency text to a number", () => {
    expect(applyTransforms("$4,182.55", [{ kind: "currencyToNumber", currency: "USD" }]))
      .toEqual({ ok: true, value: 4182.55 });
  });
  it("applies the pipeline in order", () => {
    expect(applyTransforms("  Member: Dana Whitfield ",
      [{ kind: "trim" }, { kind: "stripPrefix", value: "Member: " }]))
      .toEqual({ ok: true, value: "Dana Whitfield" });
  });
  it("extracts a regex group", () => {
    expect(applyTransforms("*******4417", [{ kind: "extractGroup", pattern: "([0-9]{4})$", group: 1 }]))
      .toEqual({ ok: true, value: "4417" });
  });
  it("fails cleanly on unparseable currency instead of producing NaN", () => {
    const r = applyTransforms("n/a", [{ kind: "currencyToNumber", currency: "USD" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("currencyToNumber");
  });
  it("fails cleanly when a regex group is missing", () => {
    expect(applyTransforms("abc", [{ kind: "extractGroup", pattern: "([0-9]+)", group: 1 }]).ok)
      .toBe(false);
  });
  it("normalizes dates to ISO", () => {
    expect(applyTransforms("03/14/2026", [{ kind: "parseDate", format: "MM/DD/YYYY" }]))
      .toEqual({ ok: true, value: "2026-03-14" });
  });
});
