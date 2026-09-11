# Design report

## Architecture

The system has one organising idea: **a language model is used once, to learn; never again, to
run.** Discovery is an LLM loop that produces a reviewable artifact. Replay is a plain loop over
that artifact with no model anywhere in it.

That claim is only worth anything if it is enforced rather than asserted, so it is a test.
`tests/unit/architecture.test.ts` walks the transitive import closure of every file in `src/replay/`
and fails if any path — at any depth — reaches `src/agent/`, a provider SDK, or a browser driver.
It also pins `src/model/` and `src/resolution/` to zero dependencies beyond Zod.

The layering runs one way:

```
model/        neutral vocabulary — no I/O, no deps
resolution/   pure: (descriptor, observation) -> resolution. No browser.
surface/      perception + action. Normalizes a surface into an Observation.
replay/       deterministic execution of a recorded artifact
agent/        discovery: LLM seam, provider adapters, recorder
policy/ session/ evidence/   allowlist, control lease, redacting sink
```

Two seams matter most. **`Surface`** deliberately *cannot* resolve a target — that belongs to
`resolution/`, which keeps the resolution engine pure and shareable by any future surface.
**`LlmClient`** exposes one method returning an `AgentDecision`; everything vendor-specific lives
inside an adapter, and nothing above it learns which vendor answered.

Perception is normalized before anything reasons about it. A `UiNode` carries a role, an accessible
name, a scope (frame path plus region), and *anchors* — the label, row header, column header or
heading it sits under. No selector is ever part of the model.

## Artifact schema

A capability is a JSON document with an id, semantic version, typed inputs and outputs, an entry
checkpoint, ordered steps, a success checkpoint, an outcome table, escalation policy, provenance,
and a review block. `src/model/capability.ts` is ~250 lines of Zod plus `assertReplayable`, a
cross-field pass that rejects an artifact referencing an undeclared input, an output reading from an
unknown step, a duplicate outcome code, or a recovery containing an irreversible action. **An
artifact that could not be replayed fails at parse, not halfway through a live banking screen.**

Three decisions carry most of the weight.

**Targets are descriptions, not selectors.** Each step names a `TargetDescriptor`: a scope, an
expected role, a primary strategy and verified fallbacks, and a written rationale. The recorder
generates candidates in preference order — `anchoredCell` → `labelled` → `roleAndName` (unscoped,
then narrowed to a region) → `roleInRegion` → `ordinalInScope` — and whichever survives validation
first becomes the primary, with the rest recorded as fallbacks. Every resolution reports which tier
matched, so silent drift onto a weak strategy shows up in the trace.

**Values are typed sources, never interpolated strings.** `{from:"input"|"output"|"literal"|
"credential"}`. There is no string templating anywhere in the artifact, so there is no injection
surface, and the credential channel is structurally distinct from anything persisted.

**Strategy parameters may themselves be parameterized.** This is a deviation from the approved
design and it is what makes one recording serve every member: the search-result row is selected by
`rowKey: {from:"input", name:"memberId"}`. Binding is a separate, pure pass, so `resolveTarget`
stays a total function of (concrete descriptor, observation).

**Discovery records structure; review attaches the outcome table.** A discovered artifact carries
everything the flow needs to execute — ordered steps, target descriptors and their fallbacks, typed
inputs and outputs, transforms, checkpoints. It carries no outcomes, and deliberately so: one
successful run has not seen a permission denial or a session timeout, and a model asked to guess at
them would be inventing a safety contract from a happy path. Outcomes live in an app profile
(`profiles/corebank-teller-8.json`) and are attached at review time through `inheritsOutcomesFrom`.
That is the same mechanism that makes the table reusable across tenants, so the cost is one field
set by the reviewer who was already reading the artifact. The shipped `.discovered` artifact has an
empty `outcomes` array and the reviewed reference artifact inherits the full table; the difference
is exactly what review is for.

The recorder is the part that makes this safe. `describeTarget` generates candidates from a node's
own metadata, then **self-validates every one**: it runs each back through the real resolver against
the observation it came from and keeps it only if it resolves uniquely to the same node. A
descriptor that would not replay is never written. It also refuses text that merely *contains* a
run's data — a region titled `Member: Dana Whitfield` is dropped rather than baked in.

## Determinism and error handling

Replay is deterministic because the same descriptor and the same observation always produce the same
resolution, and that is testable with no browser at all: most of the resolution suite runs against
recorded JSON fixtures.

Outcomes are a **four-arm contract**, and the second arm is the point:

| arm | meaning | exit |
|---|---|---|
| `success` | outputs, typed and transformed | 0 |
| `business_outcome` | the app answered — `MEMBER_NOT_FOUND`, `INVALID_MEMBER_ID` | **0** |
| `escalated` | a human is needed, with the context to act; after a hand-back, `finalStatus` says what was then verified — `success`, `failed`, or `unverified` | 2 |
| `failed` | hard failure: step, expected, observed, every strategy attempted | 3 |

Conflating "no such member" with a crash is the specific mistake this contract exists to prevent.
`INVALID_INPUT` is caught pre-flight, before a browser is opened, with zero steps executed.

Recoverable conditions are declared in the artifact (or inherited from the app profile) with a
bounded recovery and a resume plan: an interstitial is dismissed and the step continues; a session
timeout re-authenticates and restarts; a transient slow load is waited through, once. Recovery is
bounded and verified — if the condition is still present afterwards, it becomes
`RECOVERY_EXHAUSTED`, not an infinite retry. Hard outcomes such as `PERMISSION_DENIED` are **never**
retried; they escalate on first sight.

Checkpoints are semantic, not URL-based, and that choice was forced by the target. In a frameset,
clicking inside the content frame does not change the top-level URL, so location conditions are
near-useless. This is authentic legacy behaviour and a genuine argument for asserting that *the
control the next step needs is now reachable* instead of asserting where the address bar points.

**Entry runs through the same outcome table**, via a synthetic step. Without that, a session timeout
*at entry* was an entry failure rather than the declared recoverable condition it plainly is.

**Waiting is symmetric.** Target resolution retried a transient load for ten seconds, but checkpoint
assertion was a single look — an asymmetry that only shows up against a real server-rendered app,
where a click navigates and the assertion lands before the new page does. It reported steps that had
worked as failures. Post-action checkpoints now get the same ten-second grace; preconditions
deliberately do not, because they describe the state *before* acting, so nothing is in flight to
wait for. A checkpoint that passes immediately still costs nothing, and outcome detection runs
first, so a known business outcome never pays the wait on its way to being returned.

The last place that asymmetry was hiding was **recovery verification**, and it was the most
expensive one. A frame mid-swap is observable with both documents' nodes in it at once — the notice
being dismissed *and* the screen replacing it — so `absent(Acknowledge)` asserted against that
snapshot fails. A recovery that had plainly worked was therefore declared `RECOVERY_EXHAUSTED`
roughly one run in four, and the run escalated and then sat waiting fifteen minutes for an operator
who was never coming. Recovery verification now gets the same ten-second grace as a checkpoint. The
general lesson is that on a server-rendered surface *every* assertion following an action has to be
a poll, and they are worth auditing as a set rather than one at a time.

## Heterogeneity and multi-tenant

Nothing in the model is web-specific: `ScopePath` is a containment path addressed by *how* it is
found (name, title, url path, index), never a CSS selector, so a desktop adapter can map it to a
native handle. `resolution/` never touches a browser. A second surface implements `Surface` and
everything above it is unchanged — the seam is real, though only the web adapter is built.

Tenant and product variation is handled by **outcome inheritance**. `inheritsOutcomesFrom` names an
app profile (`profiles/corebank-teller-8.json`); the store merges profile outcomes with the
artifact's own, keyed by code, artifact wins. `SESSION_EXPIRED` is declared once per vendor product,
not once per capability, and a tenant can specialize a single outcome without re-recording anything.
Evaluation order is fixed by class — hard before business before recoverable — so a permission
denial can never be read as a recoverable blip.

The same descriptor ladder is what absorbs cosmetic variation between tenants: a renamed button
falls to the region strategy, an added column leaves row-by-column anchoring intact, and the trace
records which tier caught it.

## Escalation and handoff

An escalation carries everything a human needs to act without reconstructing the run: the goal, the
step and its intent, why it stopped, expected versus observed, a screenshot, the observation, and a
resume plan.

The handoff is real rather than decorative because of the **control lease**. It is asserted on every
single surface action, so while the operator holds it automation physically cannot touch the page —
`tests/integration/operator-handoff.test.ts` asserts exactly that, along with the browser context id
being *identical* across the handoff. The operator inherits the same live session: same cookies,
same half-filled form, the page where automation stopped. That is why the console runs in the same
process as the run it supervises; a separate process would have to start its own browser and drop
the operator on a login screen.

While the operator holds control the page is instrumented, so their clicks, changes and submits land
in the same evidence stream as automation's actions, with the same vocabulary — a run's evidence has
no unexplained human-shaped gap in it. `evidence/replay-takeover/` is one such run end to end: the
denial, the intervention, four `human_action` events from the operator's own clicks, control coming
back, and the verification that followed.

**What the run may claim afterwards.** On hand-back the engine re-observes and checks two things: is
the declared outcome that stopped us still on the screen, and does the stopped step declare a
checkpoint it can re-assert? `finalStatus` is `failed` if the blocking condition survived the human,
`success` only if a real checkpoint passed, and `unverified` when the step declares no checkpoint —
because there is then nothing to check, and calling that success would report a state nobody looked
at. This was the sharpest thing a review caught: the earlier code treated "nothing to re-assert" as
"nothing went wrong", so a run could report success with the permission denial still on screen and
the operator having done nothing at all.

## Safety

- **One choke point, by convention.** Both the discovery loop and the replay engine call
  `PolicyEngine` before any action reaches a surface. Origin, path prefix, and action kind are
  allowlisted; a non-allowlisted action is blocked, not degraded. Worth being precise about the
  strength of this: unlike the no-LLM-in-replay claim, which a module-graph test makes structurally
  impossible to violate, the allowlist is enforced by its two callers. `Surface.execute` asserts the
  control lease but not policy, and `rawPage()` hands out the live page deliberately for the
  operator handoff. New code that called either directly would act unallowlisted. Making that
  impossible would mean pushing policy into the surface, which would put the allowlist behind the
  seam that is meant to be swappable per surface — so it is a stated limit, not an oversight.
- **A draft never runs unattended.** Discovery always emits `status: "draft"`, derives `risk` from
  what the recorded actions actually do, and lists weak targets for review. Policy refuses
  unattended replay of anything not `approved`.
- **The model cannot author a selector.** It points at a `Ref` from the current screen. Locator
  robustness comes from deterministic rules in `recorder.ts`. A ref it invents is rejected before
  anything happens.
- **Refusals are feedback, not crashes.** A policy denial and an undescribable target both come back
  to the model as a note so it re-plans inside the bounds.
- **Discovery is bounded on every axis:** max steps, wall clock, and no-progress detection by screen
  signature.
- **Credentials are a separate channel.** They are read from the environment at run time, never
  written into an artifact, and the re-authentication test asserts the credential value never
  appears in evidence.
- **Redaction happens at the sink**, so no call site can forget it, and the model sees financial
  figures only as `[FINANCIAL]`. It covers events and attached observations. It does **not** cover
  screenshots: a PNG is a buffer and is written verbatim. Captures only fire on an outcome or an
  escalation, so nothing in `/evidence/` shows a balance today, but that is where the code happens
  to capture rather than something the redaction layer guarantees.
- **Data is never used as an address.** The recorder will not locate a table cell by the value it is
  displaying. The live run first recorded the balance cell as `roleAndName cell "$4,182.55"`, which
  is wrong twice over: it pins the capability to one member's balance, and it writes a financial
  value into an artifact that is meant to be reviewable and shareable. Row-key by column-header
  anchoring survives because "Savings" identifies the row rather than its contents. The rule is
  scoped to cells by role — a link or a button is named by its label, which *is* its identity.

## Cuts

Stated plainly, because each one is a real limit.

- **The live discovery run is one model on one surface.** Four defects surfaced only when a real
  model drove a real browser, none of which a scripted test had caught: the loop observed before the
  click had landed, the recorder addressed a cell by its contents, a repeated extraction counted as
  "no progress" and escalated a run that had already succeeded, and checkpoints asserted without the
  grace that target resolution already had. All four are fixed and carry regression tests. The
  lesson I would carry forward is that the scripted harness proves the *plumbing*; only the live run
  proves the *judgment calls*, and the two failure sets barely overlap.

- **No desktop surface.** The seam is designed and the model is surface-neutral, but only the web
  adapter exists. An adapter that has never run proves nothing.
- **Anthropic and OpenAI adapters are named extension points, not stubs.** `createLlmClient` throws
  with instructions rather than pretending. Same reasoning.
- **No remote co-browsing.** The operator console is local and in-process. Remote takeover is a
  streaming and auth problem well outside this scope, and faking it would have made the handoff
  weaker, not stronger.
- **No tenant overlay implementation.** The profile-merge mechanism exists and is tested; a full
  per-tenant override layer is designed, not built.
- **Redaction is pattern-based for a known surface**, not general PII detection. It reliably catches
  SSNs, long account numbers and currency on this app. It is a guardrail, not a guarantee.
- **`classifyAction` is a heuristic.** It reads effect-denoting verbs in a click target's rationale
  and parameters to decide "irreversible". The original version matched every form's submit button
  including a read-only search, which is exactly the failure mode to avoid — an over-eager risk
  classifier trains people to ignore it. It is now narrow, and therefore fallible in the other
  direction: risk class is something a human confirms at review, not something the system settles.
- **ReDoS residual.** Artifact-supplied patterns (`TextMatcher.regex`, `extractGroup`,
  `InputSpec.pattern`) are compiled with `new RegExp()`. Pattern length is capped at 200 characters;
  a bounded-execution guard is not implemented. Artifacts are reviewed before approval, so this is a
  defence-in-depth gap rather than an open door — but it is a gap.
- **`ordinalInScope` exists.** Positional targeting is recorded when nothing else survives
  validation, flagged `weak`, and surfaced in the review block. Refusing to record it outright would
  just move the fragility somewhere less visible.
