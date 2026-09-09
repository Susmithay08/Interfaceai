# Handoff — resume here

**Read first:** `docs/superpowers/specs/2026-09-08-computer-use-automation-design.md` (approved
design) and `docs/superpowers/plans/2026-09-08-computer-use-automation.md` (17-task plan).
This file records what is actually built as of the last commit.

**State:** `npx tsc --noEmit` clean, `npx vitest run` → **139 passing / 14 files**.
Tasks 1–14 of the plan are done. Tasks 15–17 remain.

---

## What exists and is proven

| Layer | Path | Proven by |
|---|---|---|
| Neutral model | `src/model/` | Zero deps; hand-written readonly types are authoritative, Zod validates |
| Pure resolution | `src/resolution/` | Fallback ladder, ambiguity as failure, role mismatch, transforms, binding — all fixture-tested, no browser |
| Capability schema | `src/model/capability.ts` | `assertReplayable` cross-field checks; reference artifact validates |
| Hostile target app | `apps/target-app/` | 14 tests: happy path + 7 injectable faults |
| Policy | `src/policy/` | Allowlist, risk classification, redaction |
| Lease / escalation / evidence | `src/session/`, `src/evidence/` | Lease enforced on every action; redaction at the sink |
| Store | `src/store/` | Versioned, immutable, profile outcome inheritance |
| Playwright surface | `src/surface/` | Live perception; row×column anchoring picks Savings vs Checking |
| **Replay engine** | `src/replay/` | **17 integration tests — every arm of the result contract** |
| LLM seam + Groq | `src/agent/llm/` | Provider-neutral `AgentDecision`; model points at a ref, cannot author a selector |
| Recorder | `src/agent/recorder.ts` | Written, **not yet tested** — see next steps |

### Requirements already demonstrable

- Deterministic replay, no LLM: two runs → identical step traces; `replay/` imports no LLM.
- Typed outputs: `savingsBalance` → `4182.55` (number), name and last-4 via declared transforms.
- Parameterized reuse: same artifact reads member `100999` → `210`, nothing re-recorded.
- Business outcome ≠ failure: `MEMBER_NOT_FOUND`, `INVALID_MEMBER_ID` return as answers with
  the app's own wording; `INVALID_INPUT` caught pre-flight with zero steps executed.
- Recoverable: interstitial dismissed → success; session timeout → re-auth → restart → success;
  transient slow load waited through.
- Hard failure: permission denial escalates rather than retries; unresolved target reports step,
  expected, observed and every strategy attempted.
- Safety: non-allowlisted action kind blocked; `draft` capability will not run unattended;
  credential value never appears in evidence during re-auth.

---

## What remains — in order

### 1. Recorder tests (plan Task 14)  ← start here, it is written but unproven
Create `tests/unit/agent/recorder.test.ts`. The load-bearing test:

```ts
it("self-validates: every descriptor resolves back to the same ref, uniquely", () => {
  const o = loadObservation("member-detail");
  for (const n of o.nodes) {
    const t = describeTarget(n.ref, o);
    if (!t) continue;
    const bound = bindTarget(t, { inputs: {}, outputs: {}, credentials: () => undefined });
    const r = resolveTarget(bound.ok ? bound.target : t as never, o);
    expect(r.ok && r.ref === n.ref).toBe(true);
  }
});
```
Also cover: prefers `labelled` for a labelled control; prefers `anchoredCell` for a table cell;
returns `null` for an ambiguous node; **parameterizes** a param equal to an input value
(`{from:"input"}`); **rejects** a region/name that merely contains an input value (data-dependent —
e.g. region `"Member: Dana Whitfield"`); `finalizeCapability` emits `status:"draft"` and an
artifact that `parseCapability` accepts.

### 2. Discovery loop (plan Task 15) — `src/agent/discovery-loop.ts`
Bounded `observe → redact → decide → self-validate → policy → act`. Per spec §4:
- Model returns a `Ref`; `describeTarget` converts it, `null` ⇒ re-prompt with a note, not a crash.
- Policy denial is fed back as a `DecisionSummary.note` so the model re-plans in bounds.
- Stop on `maxSteps`, wall clock, no-progress (`screenSignature` unchanged), or `stuck` → escalate.
- Test with a scripted fake `LlmClient` (no network) — see plan Task 15 for the test list.

### 3. CLI + operator console (plan Task 16)
`apps/cli/` — `discover | replay | capabilities list|show|schema`.
Exit codes: `0` success, `0` business outcome (code on stdout), `2` escalated, `3` failed.
`apps/operator-console/` — queue, detail, **Take control** / **Release & resume** driving
`ControlLease.transfer` + `surface.instrument()`. `src/surface/web/instrument.ts` already exists
and reports human actions into evidence.
Integration test must assert: same `contextId()` before/after, automation throws `ControlNotHeld`
while operator holds, two `control_transfer` events, at least one `human_action` event.

### 4. Live Groq run + deliverables (plan Task 17)
```bash
cp .env.example .env        # set GROQ_API_KEY
npm run target-app &
npm run cli -- discover --goal "look up member 100234 and read their current savings balance" \
  --inputs '{"memberId":"100234"}' --evidence-dir evidence/discovery-run
```
Then three replays (success / `999999` business outcome / `permissionDenied` escalation), assemble
`/evidence/`, write `/README.md` and `/REPORT.md` (seven prescribed headings), and add
`tests/unit/architecture.test.ts` proving `replay/` never imports `agent/` or a provider SDK.

Verify before claiming done: `npx tsc --noEmit && npx vitest run`.
Check nothing leaked: `grep -rE "(GROQ_API_KEY|demo-pass|[0-9]{9,})" evidence/ | grep -v REDACTED`

---

## Deviations from the approved design (all deliberate, all for REPORT.md)

1. **Parameterized targets.** `TargetStrategy.params` may hold a typed `ValueSource`, bound to
   literals *before* resolution. Needed because step 3 selects the result row for the caller's
   member ID. `resolveTarget` still takes a `ConcreteTargetDescriptor` and stays pure.
2. **One way to wait.** `wait` is an action kind; there is no step-level wait guard.
   `$ref` target pointers were dropped — descriptors are inline.
3. **Entry runs through the outcome table** via a synthetic step, reusing the same bounded
   recovery. Otherwise a session timeout *at entry* was an entry failure rather than the
   declared recoverable condition it is.
4. **`eslint-plugin-boundaries` dropped**; the executable module-graph test (Task 17) proves the
   same property without a second place to encode it.
5. **Mutating-click heuristic narrowed.** `submit` matched every form's submit button, including
   read-only search. Now only effect-denoting verbs. Limits belong in REPORT.md §Safety.
6. **Hand-written types authoritative, Zod validates.** Inferring from the schema produced a
   second, mutable model that disagreed with the readonly types at every boundary.
7. **Anthropic/OpenAI adapters are named extension points, not stubs** — an adapter never run
   against its provider proves nothing.
8. **`slowLoad` is one-shot**, matching what "transient" means.

## Known issues to fold in

- **ReDoS**: `new RegExp()` on artifact-supplied patterns (`TextMatcher.regex`, `extractGroup`,
  `InputSpec.pattern`). Pattern length is capped at 200 chars; a bounded-execution guard is still
  worth adding, and the residual limit belongs in REPORT.md.
- **Frameset consequence**: clicking inside the `content` frame does not change the top-level URL,
  so `location` conditions are near-useless in this app. Authentic legacy behaviour and a genuine
  argument for semantic checkpoints — worth a paragraph in REPORT.md §Determinism.
- `isPlainString` in `recorder.ts` is currently unused; remove it or use it.
- Redaction is pattern-based for a known surface, not general PII detection. Say so in REPORT.md.
