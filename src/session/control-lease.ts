import { ControlNotHeldError, type Holder, type LeaseChange } from "../model/escalation.js";

/**
 * Who is allowed to drive the live session right now.
 *
 * This is what makes the human handoff real rather than decorative: it is asserted on
 * every single surface action, so while the operator holds it, automation physically
 * cannot act on the page - and vice versa.
 */
export class ControlLease {
  #holder: Holder = "none";
  readonly #listeners = new Set<(e: LeaseChange) => void>();
  readonly #history: LeaseChange[] = [];

  holder(): Holder {
    return this.#holder;
  }

  history(): readonly LeaseChange[] {
    return this.#history;
  }

  assertHeldBy(who: Holder): void {
    if (this.#holder !== who) throw new ControlNotHeldError(who, this.#holder);
  }

  acquire(who: Exclude<Holder, "none">, reason = "acquired"): void {
    if (this.#holder !== "none" && this.#holder !== who) {
      throw new Error(`cannot acquire: ${this.#holder} already holds the session`);
    }
    this.#emit(this.#holder, who, reason);
  }

  transfer(from: Holder, to: Holder, reason: string): void {
    if (this.#holder !== from) {
      throw new Error(`cannot transfer from ${from}: ${this.#holder} holds the session`);
    }
    this.#emit(from, to, reason);
  }

  release(who: Holder, reason = "released"): void {
    this.assertHeldBy(who);
    this.#emit(who, "none", reason);
  }

  /** Used by an escalated run to park until the operator hands control back. */
  waitUntilHeldBy(who: Holder, timeoutMs: number): Promise<void> {
    if (this.#holder === who) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#listeners.delete(onChange);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${who} to hold the session`));
      }, timeoutMs);

      const onChange = (e: LeaseChange): void => {
        if (e.to !== who) return;
        clearTimeout(timer);
        this.#listeners.delete(onChange);
        resolve();
      };
      this.#listeners.add(onChange);
    });
  }

  onChange(cb: (e: LeaseChange) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #emit(from: Holder, to: Holder, reason: string): void {
    this.#holder = to;
    const change: LeaseChange = { from, to, reason, at: new Date().toISOString() };
    this.#history.push(change);
    for (const cb of [...this.#listeners]) cb(change);
  }
}
