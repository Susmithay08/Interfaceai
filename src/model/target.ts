import type { Ref } from "./ids.js";
import type { ScopePath } from "./observation.js";

export type StrategyKind =
  | "roleAndName"
  | "labelled"
  | "anchoredCell"
  | "roleInRegion"
  | "ordinalInScope";

export type MatchMode = "exact" | "normalized" | "prefix";

export interface TargetStrategy {
  readonly kind: StrategyKind;
  readonly params: Readonly<Record<string, string | number>>;
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

export type AttemptOutcome = "matched" | "noMatch" | "ambiguous" | "roleMismatch";

export interface StrategyAttempt {
  readonly strategy: TargetStrategy;
  readonly tier: number;
  readonly matchCount: number;
  readonly outcome: AttemptOutcome;
}

export type Resolution =
  | {
      readonly ok: true;
      readonly ref: Ref;
      readonly tier: number;
      readonly strategyUsed: TargetStrategy;
      readonly attempts: readonly StrategyAttempt[];
    }
  | {
      readonly ok: false;
      readonly reason: "notFound" | "ambiguous" | "roleMismatch";
      readonly matchCount: number;
      readonly attempts: readonly StrategyAttempt[];
    };
