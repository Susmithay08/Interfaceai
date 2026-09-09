/**
 * Injectable runtime faults.
 *
 * The point of this app is not that its UI is hard to read - it is that a replay must
 * survive the conditions that legitimately occur at run time. These are the ones the
 * capability's outcome table has to account for.
 */
export type FaultName =
  | "notFound"
  | "validationError"
  | "interstitial"
  | "sessionExpired"
  | "permissionDenied"
  | "slowLoad"
  | "appError";

export const FAULT_NAMES: readonly FaultName[] = [
  "notFound",
  "validationError",
  "interstitial",
  "sessionExpired",
  "permissionDenied",
  "slowLoad",
  "appError",
];

interface FaultState {
  armed: FaultName | null;
  /** Session-scoped: cleared by signing on again, or by acknowledging the interstitial. */
  cleared: boolean;
}

const state: FaultState = { armed: null, cleared: false };

export function arm(fault: FaultName | null): void {
  state.armed = fault;
  state.cleared = false;
}

export function reset(): void {
  state.armed = null;
  state.cleared = false;
}

export function isArmed(fault: FaultName): boolean {
  return state.armed === fault && !state.cleared;
}

export function current(): FaultName | null {
  return state.cleared ? null : state.armed;
}

/** One-shot faults clear once the operator (or the automation's recovery) deals with them. */
export function clearOnce(): void {
  state.cleared = true;
}

export function isFaultName(x: unknown): x is FaultName {
  return typeof x === "string" && (FAULT_NAMES as readonly string[]).includes(x);
}
