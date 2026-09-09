import type { Ref } from "../../model/ids.js";
import type { ActionKind, KeyName } from "../../model/action.js";

/**
 * The provider seam.
 *
 * Everything provider-specific - message formatting, tool/function-call schema, auth,
 * model configuration - lives inside an adapter. The discovery loop consumes only
 * AgentDecision and never learns which vendor answered.
 */
export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  decide(req: DecisionRequest): Promise<AgentDecision>;
}

export interface ObservedNode {
  readonly ref: Ref;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly region?: string;
  readonly frame: string;
  readonly anchors: readonly string[];
}

export interface DecisionSummary {
  readonly step: number;
  readonly action: string;
  readonly rationale: string;
  /** Feedback the loop injects, e.g. a policy denial, so the model re-plans in-bounds. */
  readonly note?: string;
}

export interface DecisionRequest {
  readonly goal: string;
  /** Redacted or placeholdered. Raw sensitive values never reach a provider. */
  readonly inputs: Readonly<Record<string, string>>;
  readonly screenTitle?: string;
  readonly nodes: readonly ObservedNode[];
  readonly history: readonly DecisionSummary[];
  readonly allowedActions: readonly ActionKind[];
}

export type ProposedAction =
  | { readonly kind: "click" }
  | { readonly kind: "fill"; readonly inputName: string }
  | { readonly kind: "select"; readonly inputName: string }
  | { readonly kind: "pressKey"; readonly key: KeyName }
  | { readonly kind: "dismiss" };

/**
 * The model POINTS at a node by ref. It cannot author a selector: locator robustness is
 * produced by deterministic rules in recorder.ts, not improvised by a language model.
 */
export type AgentDecision =
  | {
      readonly kind: "act";
      readonly ref: Ref;
      readonly action: ProposedAction;
      readonly rationale: string;
    }
  | {
      readonly kind: "extract";
      readonly ref: Ref;
      readonly field: string;
      readonly as: "string" | "number";
      readonly rationale: string;
    }
  | { readonly kind: "done"; readonly summary: string }
  | { readonly kind: "stuck"; readonly reason: string };
