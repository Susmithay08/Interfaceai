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
only the Groq adapter is implemented (see *Cuts* in `REPORT.md`).

---

## The demo path

Start the target app in one terminal:

```bash
npm run target-app          # http://localhost:4000/teller
```

### 1. Replay — deterministic, no LLM

```bash
npm run cli -- replay corebank.member.readSavingsBalance \
  --inputs '{"memberId":"100234"}' --evidence-dir evidence/replay-success
```

```
status: success
{ "memberName": "Dana Whitfield", "savingsBalance": 4182.55, "savingsAccountLast4": "4417" }
steps: s1(tier 0) -> s2(tier 0) -> s3(tier 0) -> s4(tier -)
```

`savingsBalance` is a **number**, not `"$4,182.55"` — the artifact declares the transform.

### 2. The same artifact, a different member — nothing re-recorded

```bash
npm run cli -- replay corebank.member.readSavingsBalance --inputs '{"memberId":"100999"}'
```

### 3. A business outcome is an answer, not a crash

```bash
npm run cli -- replay corebank.member.readSavingsBalance \
  --inputs '{"memberId":"999999"}' --evidence-dir evidence/replay-business-outcome
echo $?      # 0
```

```
status: business_outcome
code: MEMBER_NOT_FOUND
message: No matching member for that ID.
```

### 4. A permission denial escalates — and is never retried

```bash
curl -XPOST -H 'content-type: application/json' \
  -d '{"fault":"permissionDenied"}' http://localhost:4000/_control/faults

npm run cli -- replay corebank.member.readSavingsBalance \
  --inputs '{"memberId":"100234"}' --evidence-dir evidence/replay-escalation \
  --console-port 4100 --operator-timeout 60
echo $?      # 2

curl -XPOST http://localhost:4000/_control/reset
```

With `--console-port`, the operator console is at <http://localhost:4100>. It runs **in the same
process as the run**, so *Take control* hands a human the live page exactly where automation stopped
— same context, same cookies. While they hold it, automation cannot act; what they do is recorded.

### 5. Discovery — the one part that needs a key

```bash
npm run cli -- discover \
  --goal "look up member 100234 and read their current savings balance" \
  --inputs '{"memberId":"100234"}' \
  --id corebank.member.readSavingsBalance.discovered \
  --evidence-dir evidence/discovery-run
```

The recorded artifact is always `status: "draft"`. Discovery never approves its own work: a human
reviews the risk class, the output sensitivities, and any weak target before it can replay
unattended. Add `--save` to write it into `capabilities/`.

Evidence from a real run against `openai/gpt-oss-120b` is in `evidence/discovery-run/`.

### 6. The round trip — replay what the model discovered

Discovery with `--save` writes the draft into `capabilities/`. Replaying a **draft** escalates
rather than running unattended, which is the approval gate doing its job; promote it to
`approved` after reviewing its locators and output sensitivities, then:

```bash
npm run cli -- replay corebank.member.readSavingsBalance.discovered   --inputs '{"memberId":"100234"}' --evidence-dir evidence/replay-discovered
```

```
status: success
{ "currentSavingsBalance": "$4,182.55" }
steps: s1(tier 0) -> s2(tier 0) -> s3(tier 0)
```

Every step resolves at tier 0 — the primary locator, no fallback needed. See
`evidence/replay-discovered/`.

### Faults you can arm

`notFound`, `validationError`, `interstitial`, `sessionExpired`, `permissionDenied`, `slowLoad`,
`appError` — via `POST /_control/faults {"fault":"<name>"}`, cleared with `POST /_control/reset`.

---

## Other commands

```bash
npm run cli -- capabilities list                 # the catalog
npm run cli -- capabilities show <id[@version]>  # one artifact
npm run cli -- capabilities schema               # what every artifact is validated against
```

Exit codes: `0` success **and** business outcome, `2` escalated, `3` hard failure, `1` bad usage.

## Verification

```bash
npm run typecheck
npm test
```

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
| `docs/`, `REPORT.md` | Design, plan, and the written argument. |
