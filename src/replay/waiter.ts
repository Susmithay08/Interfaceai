import type { ConcreteCondition } from "../model/condition.js";
import type { Observation } from "../model/observation.js";
import { evaluateCondition } from "../resolution/evaluate.js";

export interface WaitResult {
  readonly ok: boolean;
  readonly observation: Observation;
  readonly elapsedMs: number;
  readonly attempts: number;
  readonly detail: string;
}

/**
 * Fixed-interval polling with a hard budget. No jitter, no exponential backoff:
 * determinism is worth more here than cleverness, and a bounded, predictable wait is
 * what makes a transient slow load distinguishable from a genuine failure.
 */
export async function waitFor(
  condition: ConcreteCondition,
  observe: () => Promise<Observation>,
  timeoutMs: number,
  pollMs: number,
): Promise<WaitResult> {
  const started = Date.now();
  let attempts = 0;
  let observation = await observe();
  let result = evaluateCondition(condition, observation);
  attempts++;

  while (!result.passed && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    observation = await observe();
    result = evaluateCondition(condition, observation);
    attempts++;
  }

  return {
    ok: result.passed,
    observation,
    elapsedMs: Date.now() - started,
    attempts,
    detail: result.detail,
  };
}
