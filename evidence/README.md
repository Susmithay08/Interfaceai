# Evidence

One directory per run, all in the same event vocabulary, so a discovery run and a replay run can be
read side by side.

| Run | What it shows |
|---|---|
| `discovery-run/` | The live LLM run that produced an artifact from a goal: every observation, decision, policy verdict and action. |
| `replay-discovered/` | That same discovered artifact replayed with no model — the round trip closed. |
| `replay-success/` | The reviewed artifact replayed. Typed outputs, including a `number` balance. |
| `replay-business-outcome/` | Member `999999` — `MEMBER_NOT_FOUND`, returned as an answer, exit 0. |
| `replay-recovery/` | `SESSION_EXPIRED` — detected, recovered, verified, and the run completes. |
| `replay-escalation/` | `PERMISSION_DENIED` — escalated on first sight, never retried, and nobody came: the intervention times out. |
| `replay-takeover/` | The same escalation, but a human takes the live session, finishes the step by hand, and gives it back. |

Each contains `run.jsonl` (the event log), `observations/`, `screenshots/`, a `result.json` for a
replay or a `capability-draft.json` for a discovery run, and, where a run escalated,
`interventions/`.

These bundles are immutable. Everything the README's demo commands produce goes to
`evidence/demo/`, which is gitignored, so running the demo never overwrites what is here.

## The discovery run

Goal: *"look up member 100234 and read their current savings balance"*, against
`openai/gpt-oss-120b` on Groq. The model was given the accessibility tree and a ref per node; it
never saw or authored a selector. It recorded three steps and one output:

| Step | Locator the recorder derived |
|---|---|
| `s1` fill | `labelled` — "Member ID" |
| `s2` click | `roleAndName` — button "Search" |
| `s3` click | `roleAndName` — link named `{from: input, name: memberId}` |
| output | `anchoredCell` — row "Savings" × column "Current Balance" |

`s3` is the one that matters: the recorder parameterized the link name to the `memberId` input, so
the recording is not pinned to member 100234. `replay-discovered/` then runs it with no LLM and
resolves every step at tier 0 — the primary locator, no fallback needed.

`discovery-run/capability-draft.json` is the artifact exactly as the run recorded it —
`status: "draft"`. Replaying a draft escalates rather than running unattended, so the copy in
`capabilities/` is the same artifact promoted to `approved` after the review recorded in its
`review` block. Diffing the two shows precisely what the human review changed: the status and the
note, and nothing else.

## The recovery run

`replay-recovery/` is the `sessionExpired` fault armed before a replay. Four events tell the whole
story, in order:

```
outcome_detected   entry   SESSION_EXPIRED   recoverable
recovery_attempt   entry   attempt 1 of 2    resume: restart   verified: true
...
run_finished       success
```

The run enters the app, lands on a sign-on screen instead of the search form, matches the
`SESSION_EXPIRED` outcome inherited from `profiles/corebank-teller-8.json`, re-authenticates from
the environment, restarts, and completes normally. The recovery is bounded (`maxAttempts: 2`) and
its `verify` condition is asserted before the run is allowed to continue — `verified: true` is that
assertion passing, not an assumption. No credential value appears anywhere in the bundle.

## The takeover run

`replay-takeover/` is the one bundle where a human actually took the wheel. The entitlement check
was denied on the member *detail* screen, so the run stopped on step `s3` — a step that declares a
checkpoint, which is what makes the verification at the end mean something. The event log, in
order:

```
action                 s3   click
outcome_detected       s3   PERMISSION_DENIED   hard
escalation             iv_7bf32206   riskyAction   s3
control_transfer       automation -> operator
human_action           operator   change   textbox "Member ID"
human_action           operator   click    button "Search"
human_action           operator   submit   form "Member ID"
human_action           operator   click    link "100234"
control_transfer       operator -> automation
handback_verification  s3   success   "s3 after handback: resolved at tier 0"
run_finished           escalated
```

The four `human_action` events are the operator's own clicks, captured by the page instrumentation
that `Take control` installs — automation could not have produced them, because while the operator
held the lease every automated action on that page would have thrown. `handback_verification` is
the engine re-asserting `s3`'s checkpoint against the screen the human left behind. Had that step
declared no checkpoint, the result would read `unverified` rather than `success`: a run nobody
checked is never reported as one that worked.

The run's final `status` stays `escalated` — a human was needed, and the caller is told so.
`finalStatus` is what was established afterwards.

Reproduce it with the headed command in README §6. This bundle was recorded through the same code
path — real engine, real console over HTTP, real lease, one real browser session — with the
operator's clicks issued against the same live page object a hand on a mouse drives.

## Redaction

Redaction happens at the sink, so no call site can skip it: currency appears as `[FINANCIAL]`,
account numbers as `[REDACTED-ACCT]`, and no credential value is ever written. A grep for long digit
runs across this directory matches only hex screen signatures and epoch-millisecond filenames.

Two seams are worth naming rather than glossing:

- The balance is redacted in the *logs* and never used as a *locator*, but it is returned to the
  caller in `result.json` — that is the answer the capability exists to produce.
- **Screenshots are written verbatim.** `redactDeep` runs over events and attached observations;
  a PNG is a buffer and passes through untouched. Captures only fire on an outcome or an
  escalation, so none of the screenshots here shows a balance, but that is the code path's doing
  and not a guarantee the redaction layer provides.
