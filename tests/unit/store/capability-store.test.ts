import { describe, it, expect } from "vitest";
import { FileCapabilityStore } from "../../../src/store/capability-store.js";
import { parseCapability } from "../../../src/model/capability.js";
import { readFileSync } from "node:fs";

const store = new FileCapabilityStore("capabilities", "profiles");
const REF = "corebank.member.readSavingsBalance";

describe("reference artifact", () => {
  it("passes full schema validation including replayability assertions", () => {
    const raw = JSON.parse(
      readFileSync(`capabilities/${REF}/1.0.0.json`, "utf8"),
    );
    expect(() => parseCapability(raw)).not.toThrow();
  });

  it("contains no absolute URLs", () => {
    const raw = readFileSync(`capabilities/${REF}/1.0.0.json`, "utf8");
    expect(raw).not.toMatch(/https?:\/\//);
  });

  it("contains no credential values, only credential references", () => {
    const profile = readFileSync("profiles/corebank-teller-8.json", "utf8");
    expect(profile).toContain('"from": "credential"');
    expect(profile).not.toContain("demo-pass");
  });
});

describe("FileCapabilityStore", () => {
  it("loads the highest version when none is specified", () => {
    expect(store.load(REF).version).toBe("1.0.0");
  });

  it("refuses to overwrite an existing version", () => {
    expect(() => store.save(store.load(REF))).toThrow(/immutable/);
  });

  it("lists the catalog with the agent-facing contract summary", () => {
    const summary = store.list().find((c) => c.id === REF)!;
    expect(summary.inputs).toEqual(["memberId"]);
    expect(summary.outputs).toContain("savingsBalance");
    expect(summary.status).toBe("approved");
    expect(summary.risk).toBe("readOnly");
  });
});

describe("outcome inheritance", () => {
  it("merges profile outcomes beneath the artifact's own", () => {
    const codes = store.resolveOutcomes(store.load(REF)).map((o) => o.code);
    expect(codes).toContain("SESSION_EXPIRED");
    expect(codes).toContain("INTERSTITIAL_NOTICE");
    expect(codes).toContain("MEMBER_NOT_FOUND");
  });

  it("orders hard outcomes before business before recoverable", () => {
    const classes = store.resolveOutcomes(store.load(REF)).map((o) => o.class);
    const firstBusiness = classes.indexOf("business");
    const firstRecoverable = classes.indexOf("recoverable");
    expect(classes.lastIndexOf("hard")).toBeLessThan(firstBusiness);
    expect(firstBusiness).toBeLessThan(firstRecoverable);
  });

  it("lets an artifact override a profile outcome by code", () => {
    const cap = store.load(REF);
    const overridden = {
      ...cap,
      outcomes: [
        ...cap.outcomes,
        {
          code: "APP_ERROR",
          class: "hard" as const,
          scope: "anyStep" as const,
          description: "Tenant-specific override of the shared app error detector.",
          detect: cap.outcomes[0]!.detect,
          escalate: true,
        },
      ],
    };
    const appError = store.resolveOutcomes(overridden).filter((o) => o.code === "APP_ERROR");
    expect(appError).toHaveLength(1);
    expect(appError[0]!.description).toContain("Tenant-specific override");
  });
});
