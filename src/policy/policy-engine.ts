import type { ActionKind, StepAction } from "../model/action.js";
import type { Observation } from "../model/observation.js";
import { classifyAction, type RiskClass } from "./risk.js";
import { redactObservation } from "./redaction.js";

export interface PolicyConfig {
  readonly allowedOrigins: readonly string[];
  readonly allowedPathPrefixes: readonly string[];
  readonly allowedActionKinds: readonly ActionKind[];
}

export const defaultPolicy = (): PolicyConfig => ({
  allowedOrigins: [process.env["TARGET_BASE_URL"] ?? "http://localhost:4000"],
  allowedPathPrefixes: ["/teller"],
  allowedActionKinds: ["click", "fill", "select", "pressKey", "wait", "navigate", "dismiss"],
});

export type PolicyDenialCode =
  | "ORIGIN_NOT_ALLOWED"
  | "PATH_NOT_ALLOWED"
  | "ACTION_KIND_NOT_ALLOWED";

export type PolicyVerdict =
  | { readonly allow: "yes" }
  | { readonly allow: "no"; readonly code: PolicyDenialCode; readonly reason: string }
  | { readonly allow: "withConfirmation"; readonly reason: string };

export interface PolicyContext {
  readonly mode: "discovery" | "replay";
  readonly approval?: "draft" | "in_review" | "approved" | "deprecated";
  readonly unattended: boolean;
}

/**
 * The single choke point. Both the discovery loop and the replay engine call this before
 * any action reaches a surface, so the allowlist cannot be bypassed by whichever path runs.
 */
export class PolicyEngine {
  constructor(private readonly cfg: PolicyConfig) {}

  checkNavigation(url: string): PolicyVerdict {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { allow: "no", code: "ORIGIN_NOT_ALLOWED", reason: `unparseable URL: ${url}` };
    }
    if (!this.cfg.allowedOrigins.includes(u.origin)) {
      return {
        allow: "no",
        code: "ORIGIN_NOT_ALLOWED",
        reason: `origin ${u.origin} is not on the allowlist`,
      };
    }
    if (!this.cfg.allowedPathPrefixes.some((p) => u.pathname.startsWith(p))) {
      return {
        allow: "no",
        code: "PATH_NOT_ALLOWED",
        reason: `path ${u.pathname} is not on the allowlist`,
      };
    }
    return { allow: "yes" };
  }

  classify(a: StepAction): RiskClass {
    return classifyAction(a);
  }

  checkAction(a: StepAction, ctx: PolicyContext): PolicyVerdict {
    if (!this.cfg.allowedActionKinds.includes(a.kind)) {
      return {
        allow: "no",
        code: "ACTION_KIND_NOT_ALLOWED",
        reason: `action kind "${a.kind}" is not permitted by policy`,
      };
    }

    if (this.classify(a) === "irreversible" && ctx.unattended) {
      return { allow: "withConfirmation", reason: "irreversible action attempted unattended" };
    }

    if (ctx.mode === "replay" && ctx.approval !== "approved") {
      return {
        allow: "withConfirmation",
        reason: `capability status is "${ctx.approval ?? "unknown"}", not approved for unattended replay`,
      };
    }

    return { allow: "yes" };
  }

  redactObservation(o: Observation): Observation {
    return redactObservation(o);
  }
}
