import type { EvidenceSink } from "../model/evidence.js";
import type { Holder } from "../model/escalation.js";
import type { Surface } from "../surface/surface.js";
import type { ControlLease } from "./control-lease.js";

export interface HandoffDeps {
  readonly lease: ControlLease;
  readonly surface: Surface;
  readonly evidence: EvidenceSink;
}

/**
 * The human half of the escalation contract.
 *
 * The handoff is the SAME live session, not a fresh browser: the operator picks up the
 * page where automation left it - same context, same cookies, same half-filled form - and
 * hands it back in whatever state they leave it. That is only meaningful because the
 * lease is asserted on every surface action, so while the operator holds it automation
 * physically cannot act, and everything the operator does is instrumented into evidence.
 */
export class OperatorHandoff {
  constructor(private readonly deps: HandoffDeps) {}

  holder(): Holder {
    return this.deps.lease.holder();
  }

  /** Give the operator the wheel and start recording what they do. */
  async take(reason: string): Promise<void> {
    const from = this.deps.lease.holder();
    if (from !== "operator") {
      this.deps.lease.transfer(from, "operator", reason);
      this.#log(from, "operator", reason);
    }
    await this.deps.surface.instrument(true);
  }

  /** Hand the wheel back. Automation resumes against whatever state the operator left. */
  async release(reason: string): Promise<void> {
    this.deps.lease.assertHeldBy("operator");
    await this.deps.surface.instrument(false);
    this.deps.lease.transfer("operator", "automation", reason);
    this.#log("operator", "automation", reason);
  }

  #log(from: Holder, to: Holder, reason: string): void {
    this.deps.evidence.event({
      type: "control_transfer",
      from,
      to,
      reason,
      at: new Date().toISOString(),
    });
  }
}
