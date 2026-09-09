export type Holder = "automation" | "operator" | "none";

export interface LeaseChange {
  readonly from: Holder;
  readonly to: Holder;
  readonly reason: string;
  readonly at: string;
}

export type EscalationReason =
  // discovery
  | "agentStuck"
  | "noProgress"
  | "maxSteps"
  | "policyRequiresConfirmation"
  // replay
  | "targetUnresolved"
  | "targetAmbiguous"
  | "checkpointFailed"
  | "unknownState"
  | "recoveryExhausted"
  | "riskyAction";

export interface ResumePlan {
  readonly resumeAtStepId: string | null;
  readonly mode: "retryStep" | "continueAfter";
}

/**
 * Everything a human needs to act, carried with the request rather than looked up:
 * which capability and goal, which step and what it was trying to do, why it stopped,
 * what was expected versus observed, and pointers to the state and screenshot.
 */
export interface InterventionRequest {
  readonly id: string;
  readonly runId: string;
  readonly mode: "discovery" | "replay";
  readonly capabilityId?: string;
  readonly goal: string;
  readonly stepId?: string;
  readonly stepIntent?: string;
  readonly reason: EscalationReason;
  readonly expected?: string;
  readonly observed?: string;
  readonly observationRef?: string;
  readonly screenshotRef?: string;
  readonly resumePlan: ResumePlan;
  readonly createdAt: string;
  readonly status: "open" | "in_progress" | "resolved" | "timedOut";
  readonly resolutionNote?: string;
  readonly resolvedAt?: string;
}

export class ControlNotHeldError extends Error {
  constructor(expected: Holder, actual: Holder) {
    super(`ControlNotHeld: expected ${expected} to hold the session, but ${actual} does`);
    this.name = "ControlNotHeldError";
  }
}
