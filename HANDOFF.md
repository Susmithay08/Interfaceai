# Status

The plan in `docs/superpowers/plans/2026-09-08-computer-use-automation.md` is complete: tasks 1–17.

- `npx tsc --noEmit` clean, `npm test` → **175 passing / 19 files**.
- `README.md` — how to run it, including the demo path.
- `REPORT.md` — the seven prescribed headings, including an honest **Cuts** section.
- `evidence/` — live runs: success, business outcome, escalation (see `evidence/README.md`).

## The one thing still to run

The live Groq discovery run needs an API key, which no test can supply:

```bash
# set GROQ_API_KEY in .env, then:
npm run target-app &
npm run cli -- discover \
  --goal "look up member 100234 and read their current savings balance" \
  --inputs '{"memberId":"100234"}' \
  --id corebank.member.readSavingsBalance.discovered \
  --evidence-dir evidence/discovery-run
```

Everything that run depends on — perception, recording, policy, execution, and a
discovery→replay round trip against the real browser and the real app — is already proven by
`tests/integration/discovery.test.ts`, with the model replaced by a script. What the live run adds
is exactly one thing: the decisions.

## Known limits

All of them are written up in `REPORT.md` under **Cuts**: no desktop surface, no remote
co-browsing, no tenant overlay implementation, pattern-based rather than general redaction, the
`classifyAction` heuristic's limits, and the ReDoS residual on artifact-supplied patterns.

The eight deliberate deviations from the approved design are recorded in the git history and
reflected throughout `REPORT.md` — most importantly parameterized target strategies, which is what
lets one recording serve every member.

## Test timing

A clean run is ~44 seconds and green. Starting a second `npm test` before the previous one's
Chromium teardown has finished makes the suite roughly four times slower, and at that point the
browser-driven recovery tests fail on the clock rather than on behaviour. Let a run finish before
starting the next one.

Those tests wait on real page loads, a 2.5s slow-load fault, and a full re-authentication, so
`vitest.config.ts` allows 120s and a step waits up to 10s for its control before concluding the
target is unresolved. Both numbers are about tolerating a slow legacy page, which is the situation
this system exists for.
