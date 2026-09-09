import type { StepAction } from "../model/action.js";

export type RiskClass = "readOnly" | "reversible" | "irreversible";

/**
 * A click is the only action whose reversibility cannot be read off its kind, so the
 * artifact's own recorded intent is used as the signal. The verdict is stored in the
 * artifact for a human to confirm at review time, and the heuristic errs toward flagging.
 *
 * Kept in sync with the localRisk copy in model/capability.ts, which exists so that
 * model/ stays dependency-free. tests/unit/policy asserts the two agree.
 */
const MUTATING = /\b(transfer|post|delete|remove|approve|authorize|confirm|withdraw|disburse)\b/i;

export function classifyAction(a: StepAction): RiskClass {
  switch (a.kind) {
    case "wait":
    case "pressKey":
    case "navigate":
    case "dismiss":
      return "readOnly";
    case "fill":
    case "select":
      return "reversible";
    case "click":
      return MUTATING.test(`${a.target.rationale} ${JSON.stringify(a.target.primary.params)}`)
        ? "irreversible"
        : "readOnly";
  }
}

const ORDER: Record<RiskClass, number> = { readOnly: 0, reversible: 1, irreversible: 2 };

export function maxRisk(actions: readonly StepAction[]): RiskClass {
  let worst: RiskClass = "readOnly";
  for (const a of actions) {
    if (ORDER[classifyAction(a)] > ORDER[worst]) worst = classifyAction(a);
  }
  return worst;
}
