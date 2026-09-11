# CoreBank Capability Engine

An LLM drives a hostile legacy web app **once**, under policy, and records what it learned as a
**capability artifact**. Every run after that replays the artifact deterministically — no model, no
network call to a provider, same steps every time.

The target is `apps/target-app/`, a synthetic "CoreBank Teller": framesets, table layout, no test
ids, wrapper depth that shifts between renders, and seven injectable faults. All data in it is
invented.

---

## Prerequisites

- Node 20+
- `npm install`
- `npx playwright install chromium` (once)

## Setup

```bash
cp .env.example .env
```

**Replay needs no API key.** Only `discover` talks to a language model. If you just want to see the
system work end to end, skip the key and run the replay demo below.

For discovery, set `GROQ_API_KEY` in `.env`. `LLM_PROVIDER` and `LLM_MODEL` select the adapter;
only the Groq adapter is implemented (see *Cuts* in `REPORT.md`). Groq retires models regularly —
if the default 404s, list what your key can actually see:

```bash
curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"
```

**Credentials never live in an artifact.** An artifact refers to one by ref; the runtime maps the
ref to an env var (`corebank.teller.username` → `CRED_COREBANK_TELLER_USERNAME`). The two synthetic
ones in `.env.example` are what the `sessionExpired` recovery re-authenticates with — without them
that path fails rather than recovering.

**An escalated run waits for a human.** That is the point of escalation, but it means a run that
escalates blocks for the artifact's `operatorTimeoutSeconds` (900 by default) unless you pass
`--operator-timeout <seconds>`. If a replay seems to hang, it is almost certainly waiting for an
operator — attach one with `--console-port 4100`, or shorten the wait.

---

## The demo path

Start the target app in one terminal:

```bash
npm run target-app          # http://localhost:4000/teller
```

Every command below writes its evidence under `evidence/demo/`, which is gitignored and
disposable. The curated bundles beside it (`evidence/discovery-run/`, `evidence/replay-*/`)
are the submission and are never written to by these commands — run the demo as many times
as you like without destroying what it is meant to corroborate.

### 1. Replay — deterministic, no LLM

```bash
npm run cli -- replay corebank.member.readSavingsBalance \
  --inputs '{"memberId":"100234"}' --evidence-dir evidence/demo/replay-success
```

```
status: success
{ "memberName": "Dana Whitfield", "savingsBalance": 4182.55, "savingsAccountLast4": "4417" }
steps: s1(tier 0) -> s2(tier 0) -> s3(tier 0) -> s4(tier -)
```

`savingsBalance` is a **number**, not `"$4,182.55"` — the artifact declares the transform.

### 2. The same artifact, a different member — nothing re-recorded

```bash
npm run cli -- replay corebank.member.readSavingsBalance \
  --inputs '{"memberId":"100999"}' --evidence-dir evidence/demo/replay-other-member
```

### 3. A business outcome is an answer, not a crash

```bash
npm run cli -- replay corebank.member.readSavingsBalance \
  --inputs '{"memberId":"999999"}' --evidence-dir evidence/demo/replay-business-outcome
echo $?      # 0
```

```
status: business_outcome
code: MEMBER_NOT_FOUND
message: No matching member for that ID.
```

### 4. A transient session timeout is recovered, not escalated

```bash
curl -XPOST -H 'content-type: application/json' \
  -d '{"fault":"sessionExpired"}' http://localhost:4000/_control/faults

npm run cli -- replay corebank.member.readSavingsBalance \
  --inputs '{"memberId":"100234"}' --evidence-dir evidence/demo/replay-recovery
echo $?      # 0

curl -XPOST http://localhost:4000/_control/reset
```

The run lands on a sign-on screen, matches the inherited `SESSION_EXPIRED` outcome,
re-authenticates with the synthetic credentials from `.env`, restarts, and succeeds. Grep the
bundle for `outcome_detected` and `recovery_attempt` to see it. A curated copy of this run is in
`evidence/replay-recovery/`.

### 5. A permission denial escalates — and is never retried

```bash
curl -XPOST -H 'content-type: application/json' \
  -d '{"fault":"permissionDenied"}' http://localhost:4000/_control/faults

npm run cli -- replay corebank.member.readSavingsBalance \
  --inputs '{"memberId":"100234"}' --evidence-dir evidence/demo/replay-escalation \
  --operator-timeout 30
echo $?      # 2

curl -XPOST http://localhost:4000/_control/reset
```

No operator arrives, so the intervention times out and the run reports it. To actually take
over, do the next one.

### 6. Human takeover — driving the same live session by hand

This needs **`--headed`**: the operator works in the browser window the automation was using, so
there has to be one to look at.

```bash
curl -XPOST -H 'content-type: application/json' \
  -d '{"fault":"permissionDenied"}' http://localhost:4000/_control/faults

npm run cli -- replay corebank.member.readSavingsBalance \
  --inputs '{"memberId":"100234"}' --evidence-dir evidence/demo/replay-takeover \
  --headed --console-port 4100 --operator-timeout 300
```

A Chromium window opens and drives itself until it hits the denial, then stops and waits. Now:

1. Open the operator console at <http://localhost:4100> and click the intervention. It shows the
   goal, the step and its intent, expected versus observed, and paths to the screenshot and the
   observation captured at the moment it stopped.
2. Click **Take control**. Automation is now locked out of that page — the control lease is
   asserted on every action it attempts — and your clicks start being recorded.
3. In the **Chromium window**, clear the block and finish the step by hand:
   ```bash
   curl -XPOST http://localhost:4000/_control/reset     # the "entitlement fix"
   ```
   then navigate to <http://localhost:4000/teller>, search for `100234`, and open the member's
   detail screen.
4. Back in the console, click **Release & resume**.

Automation takes the wheel again and, rather than assuming you left the right state, checks two
things: is the condition that stopped the run still on screen, and does the stopped step declare a
checkpoint it can re-assert. The result reports only what it could actually establish:

```
status: escalated (riskyAction)
intervention: iv_7bf32206
resumed by: operator
post-handoff: success
  s3 after handback: resolved at tier 0
```

`post-handoff` is one of three answers, and which one you get depends on what you actually did:

| | when |
|---|---|
| `success` | the stopped step declared a checkpoint and it re-asserted against the screen you left |
| `failed` | the blocking condition is still there — e.g. you reset the fault but never navigated the browser off the denial page |
| `unverified` | the stopped step declares no checkpoint, so there was nothing to re-assert |

`unverified` is deliberately not `success`. A run a human touched and nobody re-checked must not be
reported as one that worked. Which step catches the denial depends on how fast the denial page
renders, so you may land on a step with a checkpoint (`s3`) or one without (`s2`).

A curated recording of the `success` path, including the `human_action` events for each manual
click, is in `evidence/replay-takeover/`.

The console runs **in the same process as the run**, so *Take control* hands you the live page
exactly where automation stopped — same context, same cookies, same half-filled form.

### 7. Discovery — the one part that needs a key

```bash
npm run cli -- discover \
  --goal "look up member 100234 and read their current savings balance" \
  --inputs '{"memberId":"100234"}' \
  --id corebank.member.readSavingsBalance.demo \
  --evidence-dir evidence/demo/discovery --save
```

`--id …demo` keeps your run clear of the shipped catalog; artifacts are immutable, so recording
over an existing `id@version` is refused rather than silently overwritten. `--save` writes the
artifact into `capabilities/<id>/1.0.0.json` (without it, the draft stays in the evidence bundle).

Evidence from a real run against `openai/gpt-oss-120b` is in `evidence/discovery-run/`, and the
artifact it produced is `capabilities/corebank.member.readSavingsBalance.discovered/1.0.0.json`.

### 8. Review and promote — the approval gate

The recorded artifact is always `status: "draft"`, and a draft does not replay unattended:

```bash
npm run cli -- capabilities show corebank.member.readSavingsBalance.demo
npm run cli -- replay corebank.member.readSavingsBalance.demo \
  --inputs '{"memberId":"100234"}' --evidence-dir evidence/demo/replay-draft \
  --operator-timeout 15
echo $?      # 2 - escalated: "capability status is draft, not approved for unattended replay"
```

**Promotion is a deliberate human edit, and there is no command for it.** That is the point:
discovery never approves its own work, and a reviewer reads the locators, the risk class, the
output sensitivities and `review.weakTargets` before anything runs unattended. Open
`capabilities/corebank.member.readSavingsBalance.demo/1.0.0.json` and set:

```json
  "status": "approved",
```

and fill in the `review` block with who reviewed it and what they concluded — the shipped
`.discovered` artifact carries a worked example of such a note.

### 9. The round trip — replay what the model discovered

```bash
npm run cli -- replay corebank.member.readSavingsBalance.demo \
  --inputs '{"memberId":"100999"}' --evidence-dir evidence/demo/replay-discovered
```

Or, to skip discovery entirely and replay the artifact the shipped live run produced:

```bash
npm run cli -- replay corebank.member.readSavingsBalance.discovered \
  --inputs '{"memberId":"100999"}' --evidence-dir evidence/demo/replay-discovered
```

```
status: success
{ "currentSavingsBalance": "$210.00" }
steps: s1(tier 0) -> s2(tier 0) -> s3(tier 0)
```

Discovery ran against member `100234`; this replays for `100999` with no model involved, because
the recorder parameterized the result-row locator to the `memberId` input rather than pinning it to
the value it happened to see. Every step resolves at tier 0 — the primary locator, no fallback
needed. See `evidence/replay-discovered/`.

**What a discovered artifact does and does not carry.** Discovery records the executable capability
structure: the ordered steps, the target descriptors and their fallbacks, the typed inputs and
outputs, the transforms, and the checkpoints. It does **not** invent an outcome table — one
successful run cannot show the model what a permission denial or a session timeout looks like. The
application's outcomes and recoveries live in an app profile (`profiles/corebank-teller-8.json`) and
are attached at review time via `inheritsOutcomesFrom`, which is why the shipped
`.discovered` artifact has an empty `outcomes` array while the reviewed reference artifact inherits
the full table.

### Faults you can arm

`notFound`, `validationError`, `interstitial`, `sessionExpired`, `permissionDenied`, `slowLoad`,
`appError` — via `POST /_control/faults {"fault":"<name>"}`, cleared with `POST /_control/reset`.
See **Testing** below for driving them by hand.

---

## Other commands

```bash
npm run cli -- capabilities list                 # the catalog
npm run cli -- capabilities show <id[@version]>  # one artifact
npm run cli -- capabilities schema               # what every artifact is validated against
```

## Testing

```bash
npm run typecheck    # tsc --noEmit, strict
npm test             # 185 tests, 19 files, ~70s
```

The suite needs **no API key and no running target app** — it starts its own. Only `discover`
talks to a model.

| Layer | Where | What it pins down |
|---|---|---|
| Pure unit | `tests/unit/resolution/`, `model/`, `policy/` | Targeting, conditions, transforms, allowlist and redaction — against recorded JSON fixtures, no browser. This is why determinism is provable offline. |
| Recorder | `tests/unit/agent/recorder.test.ts` | Every descriptor it emits resolves back to the node it came from, uniquely. Locators are never positional, duplicated, or addressed by the data they display. |
| Discovery loop | `tests/unit/agent/discovery-loop.test.ts` | The loop with a *scripted* model: stopping conditions, policy refusals fed back, escalation, output deduping. |
| Architecture | `tests/unit/architecture.test.ts` | `src/replay/` imports no LLM at any depth. The guard that keeps replay honest. |
| Integration | `tests/integration/` | Real Chromium against the real target app: perception, the discovery→replay round trip, every fault, the operator handoff, and what a run may claim after a hand-back. |

**Testing the error paths.** The target app injects faults on demand, so each exceptional state is
reachable by hand:

```bash
npm run target-app
curl -XPOST -H 'content-type: application/json'   -d '{"fault":"sessionExpired"}' http://localhost:4000/_control/faults
npm run cli -- replay corebank.member.readSavingsBalance \
  --inputs '{"memberId":"100234"}' --evidence-dir evidence/demo/fault-probe
curl -XPOST http://localhost:4000/_control/reset
```

Try `notFound`, `validationError`, `interstitial`, `sessionExpired`, `permissionDenied`,
`slowLoad`, `appError` and watch the result contract sort them into recovered, business outcome,
or escalation. Exit codes: `0` success **and** business outcome, `2` escalated, `3` hard failure,
`1` bad usage.

**If the suite is slow,** it is almost always two runs overlapping — starting a second before the
previous run's Chromium has torn down makes it several times slower. Let one finish before starting
the next. The 120s timeout in `vitest.config.ts` and the 10s a step waits for its control are both
about tolerating a slow legacy page, which is the situation this system exists for. Browser-driven
tests never assert on a bare `observe()` after an action that navigates: they poll for the state
they expect, the same way the replay engine does, so a loaded machine costs seconds rather than a
red suite.

## Layout

| Path | What it is |
|---|---|
| `src/model/` | The neutral vocabulary. Hand-written readonly types are authoritative; Zod validates. |
| `src/resolution/` | Pure targeting. No I/O, no browser — which is why determinism is provable offline. |
| `src/replay/` | The deterministic engine. Imports no LLM, at any depth (`tests/unit/architecture.test.ts`). |
| `src/agent/` | The discovery loop, the provider seam, and the self-validating recorder. |
| `src/surface/` | Playwright perception normalized into `Observation`. |
| `src/policy/`, `src/session/`, `src/evidence/` | Allowlist, control lease, redacting evidence sink. |
| `apps/` | Target app, CLI, operator console. |
| `capabilities/` | The catalog: one directory per capability, one file per version. |
| `evidence/` | Curated live runs — discovery, its replay, a business outcome, a recovery, an escalation, and a completed human takeover. `evidence/demo/` is where the README's commands write and is gitignored. |
| `REPORT.md` | The design write-up: architecture, schema, determinism, safety, and what I cut. |
