import type { StrategyAttempt } from "./target.js";

/** Failures the engine raises structurally, needing no declaration in the artifact. */
export type FailureCode =
  | "TARGET_UNRESOLVED"
  | "TARGET_AMBIGUOUS"
  | "CHECKPOINT_FAILED"
  | "WAIT_TIMEOUT"
  | "EXTRACTION_FAILED"
  | "POLICY_BLOCKED"
  | "UNKNOWN_STATE"
  | "RECOVERY_EXHAUSTED"
  | "BINDING_FAILED"
  | "ENTRY_FAILED"
  | "PRECONDITION_FAILED";

export interface StepTrace {
  readonly stepId: string;
  readonly intent: string;
  readonly actionKind: string;
  readonly tier: number | null;
  readonly durationMs: number;
  readonly outcomeCode?: string;
  readonly checkpointPassed?: boolean;
}

export interface ResolutionReportEntry {
  readonly stepId: string;
  readonly tier: number;
  readonly strategyKind: string;
}

/**
 * Four arms, and the second one is the point: a business outcome is an ANSWER, not an
 * error. It does not throw, and the CLI exits 0 for it. Conflating "no such member" with
 * a crash is the mistake this contract exists to prevent.
 */
export type ReplayResult =
  | {
      readonly status: "success";
      readonly outputs: Readonly<Record<string, unknown>>;
      readonly steps: readonly StepTrace[];
      readonly evidenceRef: string;
      readonly resolutionReport: readonly ResolutionReportEntry[];
    }
  | {
      readonly status: "business_outcome";
      readonly code: string;
      readonly message?: string;
      readonly outputs?: Readonly<Record<string, unknown>>;
      readonly steps: readonly StepTrace[];
      readonly evidenceRef: string;
    }
  | {
      readonly status: "escalated";
      readonly interventionId: string;
      readonly reason: string;
      readonly resumedBy?: "operator";
      /**
       * What was actually established after the operator handed control back.
       *
       * "unverified" is a first-class answer, not a gap: if the step the run stopped on
       * declares no checkpoint, there is nothing to re-assert, and calling that success
       * would report a state nobody checked. The caller is told the human was here and
       * that the outcome is unconfirmed, which is the truth.
       */
      readonly finalStatus?: "success" | "failed" | "unverified" | "business_outcome";
      /** Why finalStatus is what it is - the condition checked, or why none could be. */
      readonly verification?: string;
      readonly outputs?: Readonly<Record<string, unknown>>;
      readonly steps: readonly StepTrace[];
      readonly evidenceRef: string;
    }
  | {
      readonly status: "failed";
      readonly error: {
        readonly stepId: string | null;
        readonly class: "hard";
        readonly code: FailureCode;
        readonly expected: string;
        readonly observed: string;
        readonly attempts: readonly StrategyAttempt[];
      };
      readonly steps: readonly StepTrace[];
      readonly evidenceRef: string;
    };
