import type { TargetDescriptor } from "./target.js";

/**
 * Structured matcher. `regex` is an explicit, greppable opt-in rather than the default
 * representation, so checkpoints and outcome detectors stay reviewable.
 */
export interface TextMatcher {
  readonly op: "equals" | "contains" | "startsWith" | "regex";
  readonly value: string;
  readonly caseSensitive?: boolean;
  readonly normalizeWhitespace?: boolean;
}

export type LeafCondition =
  | { readonly kind: "exists"; readonly target: TargetDescriptor }
  | { readonly kind: "absent"; readonly target: TargetDescriptor }
  | { readonly kind: "text"; readonly target: TargetDescriptor; readonly match: TextMatcher }
  | { readonly kind: "value"; readonly target: TargetDescriptor; readonly match: TextMatcher }
  | { readonly kind: "location"; readonly match: TextMatcher };

/** Nesting is capped at depth 2 by construction: `all`/`any` take leaves only. */
export type Condition =
  | LeafCondition
  | { readonly kind: "all"; readonly of: readonly LeafCondition[] }
  | { readonly kind: "any"; readonly of: readonly LeafCondition[] };

export interface ConditionResult {
  readonly passed: boolean;
  readonly observed?: string;
  readonly detail: string;
}
