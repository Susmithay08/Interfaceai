import type { Observation, UiNode } from "../model/observation.js";

export type Sensitivity = "none" | "identifier" | "pii" | "financial" | "secret";

const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const ACCT = /\b\d{9,}\b/g;
const MONEY = /\$\s?[\d,]+\.\d{2}/g;
const MASKED_ACCT = /\*{3,}\d{2,}/g;

/** Field names whose values never reach evidence, whatever their content. */
const FORBIDDEN_KEYS = /^(password|passwd|secret|token|apikey|api_key|credential|authorization)$/i;

export function redactValue(v: string, s: Sensitivity): string {
  switch (s) {
    case "none":
      return v;
    case "identifier":
      return v.length <= 4 ? "[REDACTED]" : "*".repeat(v.length - 4) + v.slice(-4);
    case "pii":
    case "secret":
      return "[REDACTED]";
    case "financial":
      return "[FINANCIAL]";
  }
}

/**
 * Pattern-based scrubbing for a known surface. This is a guardrail, not general PII
 * detection - see REPORT.md. It runs at the evidence sink so no call site can forget it.
 */
export function redactText(s: string): string {
  return s
    .replace(SSN, "[REDACTED-SSN]")
    .replace(MASKED_ACCT, "[REDACTED-ACCT]")
    .replace(ACCT, "[REDACTED-ACCT]")
    .replace(MONEY, "[FINANCIAL]");
}

/**
 * Structure survives redaction: roles, scopes and anchors stay intact so the model can
 * still reason and a reviewer can still debug, but figures and identifiers do not leave.
 */
export function redactObservation(o: Observation): Observation {
  const scrub = (n: UiNode): UiNode => ({
    ...n,
    ...(n.name === undefined ? {} : { name: redactText(n.name) }),
    ...(n.value === undefined ? {} : { value: redactText(n.value) }),
    anchors: n.anchors.map((a) => ({ ...a, text: redactText(a.text) })),
  });
  return { ...o, nodes: o.nodes.map(scrub) };
}

/** Deep-scrubs any object bound for the evidence log. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.test(k)) {
        out[k] = "[REDACTED]";
        continue;
      }
      out[k] = redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}
