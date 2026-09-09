import type { ResolvedAction } from "../model/action.js";
import type { Observation } from "../model/observation.js";
import type { EvidenceRef } from "../model/evidence.js";

/**
 * The perception/action seam.
 *
 * A Surface observes (adapting whatever the raw surface exposes into a normalized
 * Observation) and executes (against ephemeral refs). It deliberately CANNOT resolve a
 * TargetDescriptor - that is resolution/'s job, and keeping it out here is what lets the
 * resolution engine stay pure and be shared by any future surface implementation.
 */
export interface Surface {
  readonly kind: "web" | "desktop";

  observe(): Promise<Observation>;

  /** Asserts the control lease before doing anything. Rejects refs from a stale observation. */
  execute(action: ResolvedAction): Promise<void>;

  capture(reason: string): Promise<EvidenceRef>;

  /** Turns human-action recording on or off during an operator handoff. */
  instrument(on: boolean): Promise<void>;

  dispose(): Promise<void>;
}

export class StaleRefError extends Error {
  constructor(ref: string) {
    super(`stale ref "${ref}": it belongs to a previous observation - re-observe before acting`);
    this.name = "StaleRefError";
  }
}
