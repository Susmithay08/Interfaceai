import type { Condition } from "./condition.js";
import type { StepAction } from "./action.js";
import type { TargetDescriptor } from "./target.js";
import type { Transform } from "./transform.js";

/**
 * The distinction the whole error model turns on:
 *  - business    a legitimate answer the caller needs ("no such member"), not a crash
 *  - recoverable a runtime blip the artifact declares how to clear, boundedly
 *  - hard        stop; a human decides
 */
export type OutcomeClass = "business" | "recoverable" | "hard";

/**
 * Bounded recovery. Reuses StepAction and Condition rather than inventing a second
 * workflow language: no branching, no loops, no nesting, max 5 actions, max 3 attempts.
 */
export interface Recovery {
  readonly actions: readonly StepAction[];
  readonly verify?: Condition;
  readonly resume: "retryStep" | "continueAfter" | "restart";
  readonly maxAttempts: 1 | 2 | 3;
}

export interface OutcomeMessage {
  readonly target: TargetDescriptor;
  readonly read: "text" | "value";
  readonly transform?: readonly Transform[];
}

export interface OutcomeDefinition {
  readonly code: string;
  readonly class: OutcomeClass;
  readonly scope: "anyStep" | { readonly steps: readonly string[] };
  readonly detect: Condition;
  readonly description: string;
  readonly message?: OutcomeMessage;
  readonly recovery?: Recovery;
  readonly escalate?: boolean;
}

/** App-wide outcomes shared by every capability on a vendor product. The reuse point. */
export interface AppProfile {
  readonly profile: string;
  readonly outcomes: readonly OutcomeDefinition[];
}
