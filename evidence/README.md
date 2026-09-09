# Evidence

One directory per run, all in the same event vocabulary, so a discovery run and a replay run can be
read side by side.

| Run | What it shows |
|---|---|
| `discovery-run/` | The live LLM run that produced the artifact: every observation, decision, policy verdict and action. |
| `replay-success/` | The same task replayed with no model. Typed outputs. |
| `replay-business-outcome/` | Member `999999` — `MEMBER_NOT_FOUND`, returned as an answer, exit 0. |
| `replay-escalation/` | `PERMISSION_DENIED` — escalated on first sight, never retried, with the intervention a human would act on. |

Each contains `run.jsonl` (the event log), `result.json` (the structured result), `observations/`,
`screenshots/`, and, where a run escalated, `interventions/`.

Redaction happens at the sink, so no call site can skip it: currency appears as `[FINANCIAL]`,
account numbers as `[REDACTED-ACCT]`, and no credential value is ever written. A grep for long digit
runs across this directory matches only hex screen signatures and epoch-millisecond filenames.
