import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FileEvidenceSink } from "../../src/evidence/sink.js";
import { PolicyEngine, defaultPolicy } from "../../src/policy/policy-engine.js";
import { ControlLease } from "../../src/session/control-lease.js";
import { EscalationService } from "../../src/session/escalation.js";
import { FileCapabilityStore } from "../../src/store/capability-store.js";
import { PlaywrightWebSurface } from "../../src/surface/web/playwright-surface.js";

export interface RuntimeOptions {
  readonly evidenceDir: string;
  readonly headed?: boolean;
  readonly slowMoMs?: number;
}

/**
 * Reads .env without a dependency. Values already in the environment win, so CI and a
 * shell export both override the file. Nothing here is ever written back out.
 */
export function loadEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.startsWith("#")) continue;
    const value = m[2]!.trim().replace(/^["']|["']$/g, "");
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = value;
  }
}

export const newRunId = (prefix: string): string => `${prefix}_${randomUUID().slice(0, 8)}`;

export const baseUrl = (): string => process.env["TARGET_BASE_URL"] ?? "http://localhost:4000";

/**
 * Credentials are read from the environment at run time and handed over one at a time.
 * They are never part of a capability artifact and never reach the evidence sink.
 */
export const credentials =
  () =>
  (ref: string): string | undefined =>
    process.env[`CRED_${ref.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];

/** Everything a run needs, wired once, so `discover` and `replay` cannot drift apart. */
export async function bootstrap(opts: RuntimeOptions) {
  mkdirSync(opts.evidenceDir, { recursive: true });
  const evidence = new FileEvidenceSink(opts.evidenceDir);
  const lease = new ControlLease();
  const escalation = new EscalationService(evidence);
  const policy = new PolicyEngine({ ...defaultPolicy(), allowedOrigins: [baseUrl()] });
  const store = new FileCapabilityStore();

  const surface = await PlaywrightWebSurface.launch({
    baseUrl: baseUrl(),
    headless: opts.headed !== true,
    lease,
    evidence,
    ...(opts.slowMoMs === undefined ? {} : { slowMoMs: opts.slowMoMs }),
  });

  return { evidence, lease, escalation, policy, store, surface };
}

export const evidencePathFor = (mode: string, runId: string): string =>
  join("evidence", `${mode}-${runId}`);
