import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceSink } from "../model/evidence.js";
import type { InterventionRequest } from "../model/escalation.js";

export type NewIntervention = Omit<InterventionRequest, "id" | "createdAt" | "status">;

/**
 * Routes a stuck run to a human, carrying enough context to act on it without
 * having to reconstruct what happened: the goal, the step and its intent, why it
 * stopped, expected versus observed, and pointers to the state and screenshot.
 */
export class EscalationService {
  readonly #open = new Map<string, InterventionRequest>();
  readonly #listeners = new Set<(r: InterventionRequest) => void>();

  constructor(private readonly evidence?: EvidenceSink) {}

  raise(req: NewIntervention): InterventionRequest {
    const full: InterventionRequest = {
      ...req,
      id: `iv_${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      status: "open",
    };
    this.#open.set(full.id, full);

    this.evidence?.event({
      type: "escalation",
      interventionId: full.id,
      reason: full.reason,
      ...(full.stepId === undefined ? {} : { stepId: full.stepId }),
      at: full.createdAt,
    });

    if (this.evidence) {
      const dir = join(this.evidence.runDir, "interventions");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${full.id}.json`), JSON.stringify(full, null, 2), "utf8");
    }

    for (const cb of [...this.#listeners]) cb(full);
    return full;
  }

  get(id: string): InterventionRequest | undefined {
    return this.#open.get(id);
  }

  list(): InterventionRequest[] {
    return [...this.#open.values()];
  }

  listOpen(): InterventionRequest[] {
    return this.list().filter((r) => r.status === "open" || r.status === "in_progress");
  }

  markInProgress(id: string): void {
    this.#update(id, { status: "in_progress" });
  }

  resolve(id: string, note: string): void {
    this.#update(id, {
      status: "resolved",
      resolutionNote: note,
      resolvedAt: new Date().toISOString(),
    });
  }

  timeOut(id: string, note: string): void {
    this.#update(id, {
      status: "timedOut",
      resolutionNote: note,
      resolvedAt: new Date().toISOString(),
    });
  }

  onRaised(cb: (r: InterventionRequest) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #update(id: string, patch: Partial<InterventionRequest>): void {
    const current = this.#open.get(id);
    if (!current) return;
    const next = { ...current, ...patch } as InterventionRequest;
    this.#open.set(id, next);
    if (this.evidence) {
      const dir = join(this.evidence.runDir, "interventions");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(next, null, 2), "utf8");
    }
  }
}
