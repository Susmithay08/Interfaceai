import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { CapabilitySchema } from "../../src/model/capability.js";
import { DiscoveryLoop } from "../../src/agent/discovery-loop.js";
import { createLlmClient } from "../../src/agent/llm/providers/index.js";
import { ReplayEngine } from "../../src/replay/replay-engine.js";
import { FileCapabilityStore } from "../../src/store/capability-store.js";
import type { ReplayResult } from "../../src/model/result.js";
import { OperatorHandoff } from "../../src/session/operator-handoff.js";
import { startOperatorConsole } from "../operator-console/server.js";
import {
  baseUrl,
  bootstrap,
  credentials,
  evidencePathFor,
  loadEnv,
  newRunId,
} from "./runtime.js";

loadEnv();

/**
 * Exit codes are the contract for anything scripting this:
 *   0  success, and also a business outcome - "no such member" is an ANSWER, not a crash
 *   2  escalated to a human
 *   3  hard failure
 *   1  the CLI itself could not run (bad arguments, missing capability, no API key)
 */
const EXIT = { ok: 0, usage: 1, escalated: 2, failed: 3 } as const;

const out = (s: string): void => void process.stdout.write(`${s}\n`);
const err = (s: string): void => void process.stderr.write(`${s}\n`);

const parseInputs = (raw: string | undefined): Record<string, string> => {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--inputs must be a JSON object");
  }
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
};

const program = new Command()
  .name("corebank")
  .description("Discover a capability with an LLM, then replay it deterministically without one.");

/* ── discover ─────────────────────────────────────────────────────────── */

program
  .command("discover")
  .description("Drive the app with an LLM once and record a draft capability artifact.")
  .requiredOption("--goal <text>", "what the run should accomplish, in plain language")
  .option("--inputs <json>", "JSON object of input values available to the run", "{}")
  .option("--id <capabilityId>", "id for the recorded artifact", "corebank.discovered.capability")
  .option("--entry <path>", "path the run starts at", "/teller")
  .option("--evidence-dir <dir>", "where to write the evidence bundle")
  .option("--max-steps <n>", "hard cap on model turns", "20")
  .option("--headed", "watch the browser", false)
  .option("--save", "write the recorded artifact into capabilities/", false)
  .action(async (o) => {
    const runId = newRunId("disc");
    const rt = await bootstrap({
      evidenceDir: o.evidenceDir ?? evidencePathFor("discovery", runId),
      headed: Boolean(o.headed),
    });
    try {
      const loop = new DiscoveryLoop({ ...rt, llm: createLlmClient(), baseUrl: baseUrl() });
      const result = await loop.run({
        goal: o.goal,
        inputs: parseInputs(o.inputs),
        entryPath: o.entry,
        runId,
        capabilityId: o.id,
        maxSteps: Number(o.maxSteps),
      });

      if (result.status === "escalated") {
        err(`escalated (${result.reason}): ${result.detail}`);
        err(`intervention ${result.interventionId} - evidence in ${rt.evidence.runDir}`);
        process.exitCode = EXIT.escalated;
        return;
      }

      const path = o.save
        ? rt.store.save(result.capability)
        : writeDraft(rt.evidence.runDir, result.capability);
      out(`recorded ${result.capability.id}@${result.capability.version} (status: draft)`);
      out(`  ${result.stepCount} step(s), ${Object.keys(result.capability.outputs).length} output(s)`);
      out(`  artifact:  ${path}`);
      out(`  evidence:  ${rt.evidence.runDir}`);
      out(`  This artifact is a DRAFT. Review it, then promote it before unattended replay.`);
    } finally {
      await rt.surface.dispose();
      rt.evidence.close();
    }
  });

function writeDraft(dir: string, capability: { id: string; version: string }): string {
  const path = `${dir}/capability-draft.json`;
  writeFileSync(path, JSON.stringify(capability, null, 2), "utf8");
  return path;
}

/* ── replay ───────────────────────────────────────────────────────────── */

program
  .command("replay")
  .description("Replay a recorded capability. No LLM is involved.")
  .argument("<capability>", "capability id, optionally id@version")
  .option("--inputs <json>", "JSON object of input values", "{}")
  .option("--evidence-dir <dir>", "where to write the evidence bundle")
  .option("--attended", "allow steps that require a human to confirm", false)
  .option("--console-port <n>", "serve the operator console for this run on a port")
  .option("--operator-timeout <seconds>", "how long an escalated run waits for a human")
  .option("--headed", "watch the browser", false)
  .action(async (ref: string, o) => {
    const [id, version] = ref.split("@");
    const runId = newRunId("replay");
    const rt = await bootstrap({
      evidenceDir: o.evidenceDir ?? evidencePathFor("replay", runId),
      headed: Boolean(o.headed),
    });
    try {
      const capability = rt.store.load(id!, version);
      const engine = new ReplayEngine({
        ...rt,
        baseUrl: baseUrl(),
        outcomes: rt.store.resolveOutcomes(capability),
        credentials: credentials(),
      });
      rt.lease.acquire("automation", `replay ${runId}`);

      // The console runs in THIS process so the operator inherits the same live session.
      const console_ = o.consolePort
        ? await startOperatorConsole(
            { escalation: rt.escalation, handoff: new OperatorHandoff(rt) },
            Number(o.consolePort),
          )
        : null;
      if (console_) out(`operator console: ${console_.url}`);

      const result = await engine.replay(capability, parseInputs(o.inputs), {
        unattended: !o.attended,
        runId,
        ...(o.operatorTimeout ? { operatorTimeoutSeconds: Number(o.operatorTimeout) } : {}),
      });
      await console_?.stop();
      // The result sits beside the event log, so a bundle can be read without replaying it.
      writeFileSync(`${rt.evidence.runDir}/result.json`, JSON.stringify(result, null, 2), "utf8");
      process.exitCode = report(result);
    } finally {
      await rt.surface.dispose();
      rt.evidence.close();
    }
  });

/** One place decides how a result is rendered and what the shell sees. */
function report(r: ReplayResult): number {
  switch (r.status) {
    case "success":
      out("status: success");
      out(JSON.stringify(r.outputs, null, 2));
      out(`steps: ${r.steps.map((s) => `${s.stepId}(tier ${s.tier ?? "-"})`).join(" -> ")}`);
      out(`evidence: ${r.evidenceRef}`);
      return EXIT.ok;

    case "business_outcome":
      // Deliberately exit 0: the app answered, and the answer is the point.
      out(`status: business_outcome`);
      out(`code: ${r.code}`);
      if (r.message) out(`message: ${r.message}`);
      out(`evidence: ${r.evidenceRef}`);
      return EXIT.ok;

    case "escalated":
      err(`status: escalated (${r.reason})`);
      err(`intervention: ${r.interventionId}`);
      if (r.resumedBy) {
        err(`resumed by: ${r.resumedBy}`);
        // "unverified" is reported as loudly as a failure. A run a human touched and
        // nobody re-checked must not read as a success.
        err(`post-handoff: ${r.finalStatus ?? "unknown"}`);
        if (r.verification) err(`  ${r.verification}`);
      }
      err(`evidence: ${r.evidenceRef}`);
      return EXIT.escalated;

    case "failed":
      err(`status: failed`);
      err(`  step:     ${r.error.stepId ?? "(entry)"}`);
      err(`  code:     ${r.error.code}`);
      err(`  expected: ${r.error.expected}`);
      err(`  observed: ${r.error.observed}`);
      for (const a of r.error.attempts) {
        err(`  tried tier ${a.tier} ${a.strategy.kind}: ${a.outcome} (${a.matchCount} match(es))`);
      }
      err(`  evidence: ${r.evidenceRef}`);
      return EXIT.failed;
  }
}

/* ── capabilities ─────────────────────────────────────────────────────── */

const capabilities = program.command("capabilities").description("Inspect the capability catalog.");

capabilities
  .command("list")
  .description("List every recorded capability version.")
  .action(() => {
    const rows = new FileCapabilityStore().list();
    if (rows.length === 0) return out("no capabilities recorded yet");
    for (const c of rows) {
      out(`${c.id}@${c.version}  [${c.status}/${c.risk}]  ${c.title}`);
      out(`  in: ${c.inputs.join(", ") || "-"}   out: ${c.outputs.join(", ") || "-"}`);
    }
  });

capabilities
  .command("show")
  .description("Print one capability artifact.")
  .argument("<capability>", "capability id, optionally id@version")
  .action((ref: string) => {
    const [id, version] = ref.split("@");
    out(JSON.stringify(new FileCapabilityStore().load(id!, version), null, 2));
  });

capabilities
  .command("schema")
  .description("Print the JSON Schema every artifact is validated against.")
  .action(() => {
    // Zod is the runtime validator; this prints the shape it enforces, for reviewers.
    out(JSON.stringify(describeSchema(), null, 2));
  });

function describeSchema(): unknown {
  const shape = (CapabilitySchema as unknown as { _def: { schema: { shape: object } } })._def.schema
    .shape;
  return {
    title: "Capability artifact",
    note: "Validated by src/model/capability.ts. Cross-field checks run in assertReplayable().",
    topLevelFields: Object.keys(shape),
  };
}

/* ── entrypoint ───────────────────────────────────────────────────────── */

program.parseAsync(process.argv).catch((e: unknown) => {
  err(e instanceof Error ? e.message : String(e));
  process.exitCode = EXIT.usage;
});
