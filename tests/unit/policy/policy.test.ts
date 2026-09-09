import { describe, it, expect } from "vitest";
import { PolicyEngine, type PolicyConfig } from "../../../src/policy/policy-engine.js";
import { classifyAction } from "../../../src/policy/risk.js";
import { redactValue, redactText, redactObservation, redactDeep } from "../../../src/policy/redaction.js";
import { loadObservation } from "../../fixtures/load.js";
import type { StepAction } from "../../../src/model/action.js";
import type { TargetDescriptor } from "../../../src/model/target.js";

const cfg: PolicyConfig = {
  allowedOrigins: ["http://localhost:4000"],
  allowedPathPrefixes: ["/teller"],
  allowedActionKinds: ["click", "fill", "select", "pressKey", "wait", "navigate", "dismiss"],
};
const engine = new PolicyEngine(cfg);

const target: TargetDescriptor = {
  scope: { path: [{ by: "name", value: "content" }] },
  expectedRole: "button",
  primary: { kind: "roleAndName", params: { role: "button", name: "Search" } },
  fallbacks: [],
  cardinality: "exactlyOne",
  rationale: "Sole submit control in the search region.",
};
const click: StepAction = { kind: "click", target };
const ctx = { mode: "replay", approval: "approved", unattended: true } as const;

describe("checkNavigation", () => {
  it("allows an allowlisted origin and path", () => {
    expect(engine.checkNavigation("http://localhost:4000/teller/search").allow).toBe("yes");
  });

  it("denies a different origin", () => {
    const v = engine.checkNavigation("http://evil.example.com/teller/search");
    expect(v.allow).toBe("no");
    if (v.allow === "no") expect(v.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("denies a path outside the allowed prefixes", () => {
    const v = engine.checkNavigation("http://localhost:4000/admin/wipe");
    expect(v.allow).toBe("no");
    if (v.allow === "no") expect(v.code).toBe("PATH_NOT_ALLOWED");
  });

  it("denies an unparseable URL rather than throwing", () => {
    expect(engine.checkNavigation("not a url").allow).toBe("no");
  });
});

describe("checkAction", () => {
  it("allows a read-only action on an approved capability", () => {
    expect(engine.checkAction(click, ctx).allow).toBe("yes");
  });

  it("denies an action kind that is not allowlisted", () => {
    const narrow = new PolicyEngine({ ...cfg, allowedActionKinds: ["wait"] });
    const v = narrow.checkAction(click, ctx);
    expect(v.allow).toBe("no");
    if (v.allow === "no") expect(v.code).toBe("ACTION_KIND_NOT_ALLOWED");
  });

  it("requires confirmation for an irreversible action run unattended", () => {
    const post: StepAction = {
      kind: "click",
      target: { ...target, rationale: "Submit the transfer and post it to the core" },
    };
    expect(engine.checkAction(post, ctx).allow).toBe("withConfirmation");
  });

  it("requires confirmation for a draft capability even when read-only", () => {
    expect(engine.checkAction(click, { ...ctx, approval: "draft" }).allow).toBe("withConfirmation");
  });
});

describe("classifyAction", () => {
  it("treats fill and select as reversible", () => {
    expect(classifyAction({ kind: "fill", target, value: { from: "literal", value: "x" } }))
      .toBe("reversible");
  });

  it("treats a plain navigational click as read-only", () => {
    expect(classifyAction(click)).toBe("readOnly");
  });

  it("treats a mutating click as irreversible", () => {
    expect(classifyAction({
      kind: "click",
      target: { ...target, rationale: "Confirm and post the transfer to the core" },
    })).toBe("irreversible");
  });
});

describe("redactValue", () => {
  it("fully masks a secret", () => expect(redactValue("s3cret", "secret")).toBe("[REDACTED]"));
  it("keeps the last 4 of an identifier", () =>
    expect(redactValue("100234", "identifier")).toBe("**0234"));
  it("masks pii entirely", () => expect(redactValue("Dana Whitfield", "pii")).toBe("[REDACTED]"));
  it("keeps the shape but not the figure for financial", () =>
    expect(redactValue("$4,182.55", "financial")).toBe("[FINANCIAL]"));
  it("passes through non-sensitive values", () => expect(redactValue("Search", "none")).toBe("Search"));
});

describe("redactText", () => {
  it("masks anything shaped like an SSN", () => {
    expect(redactText("ssn 123-45-6789 on file")).toBe("ssn [REDACTED-SSN] on file");
  });
  it("masks a masked account number", () => {
    expect(redactText("acct *******4417")).toContain("[REDACTED-ACCT]");
  });
  it("masks currency figures", () => {
    expect(redactText("balance $4,182.55")).toBe("balance [FINANCIAL]");
  });
});

describe("redactObservation", () => {
  it("masks values but preserves structure for reasoning and debugging", () => {
    const original = loadObservation("member-detail");
    const scrubbed = redactObservation(original);
    expect(scrubbed.nodes).toHaveLength(original.nodes.length);
    expect(scrubbed.nodes.map((n) => n.role)).toContain("cell");
    expect(JSON.stringify(scrubbed)).not.toContain("4417");
    expect(JSON.stringify(scrubbed)).not.toContain("4,182.55");
    // anchors survive, so anchoredCell targeting is still explicable from evidence
    expect(JSON.stringify(scrubbed)).toContain("Current Balance");
  });
});

describe("redactDeep", () => {
  it("drops forbidden keys whatever their content", () => {
    const out = redactDeep({ username: "demo.teller", password: "demo-pass-not-real" });
    expect(out.password).toBe("[REDACTED]");
  });
  it("scrubs nested strings", () => {
    expect(JSON.stringify(redactDeep({ a: { b: ["ssn 123-45-6789"] } }))).toContain("[REDACTED-SSN]");
  });
});
