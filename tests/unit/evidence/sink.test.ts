import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEvidenceSink } from "../../../src/evidence/sink.js";

let dir: string;
let sink: FileEvidenceSink;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "evidence-"));
  sink = new FileEvidenceSink(dir);
});

const log = (): string => readFileSync(join(dir, "run.jsonl"), "utf8");

describe("FileEvidenceSink", () => {
  it("appends one JSON object per line", () => {
    sink.event({ type: "note", message: "one", at: "t" });
    sink.event({ type: "note", message: "two", at: "t" });
    const lines = log().trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).message).toBe("two");
  });

  it("redacts at the sink, so call sites cannot forget", () => {
    sink.event({
      type: "action", stepId: "s1", actionKind: "fill", resolutionTier: 0,
      value: "123-45-6789", durationMs: 5, at: "t",
    });
    expect(log()).not.toContain("123-45-6789");
    expect(log()).toContain("[REDACTED-SSN]");
  });

  it("never writes a credential value even when one is passed", () => {
    sink.event({ type: "note", message: "signing on", at: "t" });
    const ref = sink.attach("observation", "creds", {
      username: "demo.teller", password: "demo-pass-not-real",
    });
    const written = readFileSync(ref.path, "utf8");
    expect(written).not.toContain("demo-pass-not-real");
    expect(written).toContain("[REDACTED]");
  });

  it("masks financial figures in attached observations", () => {
    const ref = sink.attach("observation", "obs1", { nodes: [{ value: "$4,182.55" }] });
    expect(readFileSync(ref.path, "utf8")).toContain("[FINANCIAL]");
  });

  it("writes screenshot buffers verbatim and returns a reference", () => {
    const ref = sink.attach("screenshot", "shot1", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(ref.kind).toBe("screenshot");
    expect(existsSync(ref.path)).toBe(true);
  });

  it("stops writing once closed", () => {
    sink.event({ type: "note", message: "before", at: "t" });
    sink.close();
    sink.event({ type: "note", message: "after", at: "t" });
    expect(log()).not.toContain("after");
  });
});
