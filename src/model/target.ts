import type { Ref } from "./ids.js";
import type { ScopePath } from "./observation.js";
import type { ValueSource } from "./action.js";

export type StrategyKind =
  | "roleAndName"
  | "labelled"
  | "anchoredCell"
  | "roleInRegion"
  | "ordinalInScope";

export type MatchMode = "exact" | "normalized" | "prefix";

/**
 * A strategy parameter is either a literal or, for parameterized flows, a ValueSource
 * bound at run time - e.g. selecting the search-result row for the member ID the caller
 * supplied. Typed rather than string-interpolated, so it stays reviewable and injection-free.
 */
export type TargetParam = string | number | ValueSource;

export interface TargetStrategy {
  readonly kind: StrategyKind;
  readonly params: Readonly<Record<string, TargetParam>>;
  readonly match?: MatchMode;
}

/** Persistent, surface-neutral description of WHICH control to act on. Lives in artifacts. */
export interface TargetDescriptor {
  readonly scope: ScopePath;
  readonly expectedRole: string;
  readonly primary: TargetStrategy;
  readonly fallbacks: readonly TargetStrategy[];
  readonly cardinality: "exactlyOne" | "nth";
  readonly nth?: number;
  /** Why this is considered robust. Required, so every target is reviewable. */
  readonly rationale: string;
}

/* ── after binding ──────────────────────────────────────────────────────
 * Resolution operates only on concrete descriptors. Binding is a separate,
 * pure step, so resolveTarget stays a total function of (descriptor, observation).
 */

export interface ConcreteTargetStrategy {
  readonly kind: StrategyKind;
  readonly params: Readonly<Record<string, string | number>>;
  readonly match?: MatchMode;
}

export interface ConcreteTargetDescriptor {
  readonly scope: ScopePath;
  readonly expectedRole: string;
  readonly primary: ConcreteTargetStrategy;
  readonly fallbacks: readonly ConcreteTargetStrategy[];
  readonly cardinality: "exactlyOne" | "nth";
  readonly nth?: number;
  readonly rationale: string;
}

export type AttemptOutcome = "matched" | "noMatch" | "ambiguous" | "roleMismatch";

export interface StrategyAttempt {
  readonly strategy: ConcreteTargetStrategy;
  readonly tier: number;
  readonly matchCount: number;
  readonly outcome: AttemptOutcome;
}

export type Resolution =
  | {
      readonly ok: true;
      readonly ref: Ref;
      readonly tier: number;
      readonly strategyUsed: ConcreteTargetStrategy;
      readonly attempts: readonly StrategyAttempt[];
    }
  | {
      readonly ok: false;
      readonly reason: "notFound" | "ambiguous" | "roleMismatch";
      readonly matchCount: number;
      readonly attempts: readonly StrategyAttempt[];
    };
