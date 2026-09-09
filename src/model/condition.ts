import type { ConcreteTargetDescriptor, TargetDescriptor } from "./target.js";

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

/** Generic over the target form, so the persistent and concrete shapes share one definition. */
export type LeafConditionOf<T> =
  | { readonly kind: "exists"; readonly target: T }
  | { readonly kind: "absent"; readonly target: T }
  | { readonly kind: "text"; readonly target: T; readonly match: TextMatcher }
  | { readonly kind: "value"; readonly target: T; readonly match: TextMatcher }
  | { readonly kind: "location"; readonly match: TextMatcher };

/** Nesting is capped at depth 2 by construction: `all`/`any` take leaves only. */
export type ConditionOf<T> =
  | LeafConditionOf<T>
  | { readonly kind: "all"; readonly of: readonly LeafConditionOf<T>[] }
  | { readonly kind: "any"; readonly of: readonly LeafConditionOf<T>[] };

/** As stored in an artifact: targets may still carry unbound ValueSource params. */
export type LeafCondition = LeafConditionOf<TargetDescriptor>;
export type Condition = ConditionOf<TargetDescriptor>;

/** After binding: every param is a literal. Only these are evaluated. */
export type ConcreteLeafCondition = LeafConditionOf<ConcreteTargetDescriptor>;
export type ConcreteCondition = ConditionOf<ConcreteTargetDescriptor>;

export interface ConditionResult {
  readonly passed: boolean;
  readonly observed?: string;
  readonly detail: string;
}
