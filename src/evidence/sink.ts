import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceRef, EvidenceSink, RunEvent } from "../model/evidence.js";
import { redactDeep } from "../policy/redaction.js";

/**
 * Append-only JSONL plus attachments, redacted AT THE SINK.
 *
 * Redacting here rather than at call sites means no future caller can forget: everything
 * written to /evidence passes through redactDeep on the way out.
 */
export class FileEvidenceSink implements EvidenceSink {
  readonly runDir: string;
  readonly #logPath: string;
  #closed = false;

  constructor(runDir: string) {
    this.runDir = runDir;
    this.#logPath = join(runDir, "run.jsonl");
    mkdirSync(join(runDir, "screenshots"), { recursive: true });
    mkdirSync(join(runDir, "observations"), { recursive: true });
  }

  event(e: RunEvent): void {
    if (this.#closed) return;
    appendFileSync(this.#logPath, `${JSON.stringify(redactDeep(e))}\n`, "utf8");
  }

  attach(kind: EvidenceRef["kind"], name: string, data: Buffer | object): EvidenceRef {
    const dir = kind === "screenshot" ? "screenshots" : "observations";
    const ext = kind === "screenshot" ? "png" : kind === "html" ? "html" : "json";
    const path = join(this.runDir, dir, `${name}.${ext}`);
    if (Buffer.isBuffer(data)) {
      writeFileSync(path, data);
    } else {
      writeFileSync(path, JSON.stringify(redactDeep(data), null, 2), "utf8");
    }
    return { kind, path };
  }

  close(): void {
    this.#closed = true;
  }
}

/** In-memory sink for unit tests that should not touch the filesystem. */
export class MemoryEvidenceSink implements EvidenceSink {
  readonly runDir = ":memory:";
  readonly events: RunEvent[] = [];

  event(e: RunEvent): void {
    this.events.push(redactDeep(e));
  }

  attach(kind: EvidenceRef["kind"], name: string): EvidenceRef {
    return { kind, path: `:memory:/${name}` };
  }

  close(): void {
    /* nothing to flush */
  }
}
