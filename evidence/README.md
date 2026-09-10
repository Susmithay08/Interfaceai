# Evidence

One directory per run, all in the same event vocabulary, so a discovery run and a replay run can be
read side by side.

| Run | What it shows |
|---|---|
| `discovery-run/` | The live LLM run that produced an artifact from a goal: every observation, decision, policy verdict and action. |
| `replay-discovered/` | That same discovered artifact replayed with no model — the round trip closed. |
| `replay-success/` | The reviewed artifact replayed. Typed outputs, including a `number` balance. |
| `replay-business-outcome/` | Member `999999` — `MEMBER_NOT_FOUND`, returned as an answer, exit 0. |
| `replay-escalation/` | `PERMISSION_DENIED` — escalated on first sight, never retried, with the intervention a human would act on. |

Each contains `run.jsonl` (the event log), `observations/`, `screenshots/`, a `result.json` for a
replay or a `capability-draft.json` for a discovery run, and, where a run escalated,
`interventions/`.

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

## Redaction

Redaction happens at the sink, so no call site can skip it: currency appears as `[FINANCIAL]`,
account numbers as `[REDACTED-ACCT]`, and no credential value is ever written. A grep for long digit
runs across this directory matches only hex screen signatures and epoch-millisecond filenames.

Note the seam: the balance is redacted in the *logs* and never used as a *locator*, but it is
returned to the caller in `result.json` — that is the answer the capability exists to produce.
