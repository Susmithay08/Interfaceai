import type { Holder } from "./escalation.js";

export interface EvidenceRef {
  readonly kind: "screenshot" | "observation" | "html";
  readonly path: string;
}

/**
 * One event vocabulary for BOTH discovery and replay, so the two runs in /evidence
 * can be read side by side and compared directly.
 */
export type RunEvent =
  | {
      readonly type: "run_started";
      readonly runId: string;
      readonly mode: "discovery" | "replay";
      readonly goal?: string;
      readonly capabilityId?: string;
      readonly capabilityVersion?: string;
      readonly at: string;
    }
  | {
      readonly type: "run_finished";
      readonly runId: string;
      readonly status: string;
      readonly code?: string;
      readonly durationMs: number;
      readonly at: string;
    }
  | {
      readonly type: "observation";
      readonly observationId: string;
      readonly screenSignature: string;
      readonly nodeCount: number;
      readonly locationHint?: string;
      readonly ref: string;
      readonly at: string;
    }
  | {
      readonly type: "llm_decision";
      readonly provider: string;
      readonly model: string;
      readonly decision: string;
      readonly rationale: string;
      readonly targetRef?: string;
      readonly at: string;
    }
  | {
      readonly type: "policy_verdict";
      readonly actionKind: string;
      readonly verdict: string;
      readonly risk: string;
      readonly reason?: string;
      readonly at: string;
    }
  | {
      readonly type: "action";
      readonly stepId: string;
      readonly intent?: string;
      readonly actionKind: string;
      readonly resolutionTier: number | null;
      readonly strategyKind?: string;
      readonly value?: string;
      readonly durationMs: number;
      readonly at: string;
    }
  | {
      readonly type: "outcome_detected";
      readonly stepId: string;
      readonly code: string;
      readonly outcomeClass: "business" | "recoverable" | "hard";
      readonly observed?: string;
      readonly at: string;
    }
  | {
      readonly type: "recovery_attempt";
      readonly stepId: string;
      readonly code: string;
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly resume: string;
      readonly verified?: boolean;
      readonly at: string;
    }
  | {
      readonly type: "checkpoint";
      readonly stepId: string;
      readonly passed: boolean;
      readonly detail: string;
      readonly observed?: string;
      readonly at: string;
    }
  | {
      readonly type: "extraction";
      readonly output: string;
      readonly ok: boolean;
      readonly detail?: string;
      readonly at: string;
    }
  | {
      readonly type: "control_transfer";
      readonly from: Holder;
      readonly to: Holder;
      readonly reason: string;
      readonly at: string;
    }
  | {
      readonly type: "human_action";
      readonly actor: "operator";
      readonly actionKind: string;
      readonly role?: string;
      readonly accessibleName?: string;
      readonly value?: string;
      readonly at: string;
    }
  | {
      readonly type: "escalation";
      readonly interventionId: string;
      readonly reason: string;
      readonly stepId?: string;
      readonly at: string;
    }
  | {
      readonly type: "note";
      readonly message: string;
      readonly at: string;
    };

export interface EvidenceSink {
  event(e: RunEvent): void;
  attach(kind: EvidenceRef["kind"], name: string, data: Buffer | object): EvidenceRef;
  readonly runDir: string;
  close(): void;
}
