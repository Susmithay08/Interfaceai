# Computer-Use Automation System — Design

**Date:** 2026-09-08
**Status:** Approved (architecture + artifact schema)
**Source of truth:** `Assignment A — Computer-Use Automation System.pdf` (interface.ai take-home)

## Through-line

> The model discovers. The artifact becomes a reusable capability. Deterministic replay is
> how the AI agent invokes it in production.

This sentence is the design. Every structural decision below exists to make it literally true
in the codebase — most importantly, `replay/` is structurally unable to import `agent/` or
reach an LLM, and that is enforced by a lint boundary rule plus a module-graph test.

## 1. Scope and stack

| Decision | Choice | Why |
|---|---|---|
| Language | TypeScript (Node 24) | Compile-checked capability contract; Zod for runtime validation at the trust boundary |
| Automation | Playwright | Strongest web driver; used *only* inside `surface/web/` |
| Perception | DOM + accessibility information, normalized to `UiNode[]` | Legacy targets have no test IDs; role + accessible name + anchoring is what survives |
| LLM | Groq (`llama-3.3-70b-versatile`) behind a provider-neutral `LlmClient` | Free for a take-home; provider is config, not code |
| Target app | Local hostile "CoreBank Teller" | Free, offline, and the only way to *inject* the runtime failures the brief grades |
| Persistence | Filesystem | Brief explicitly does not reward scaling infrastructure |
| Process model | Single Node process, CLI-driven | Same reason |

**Not building:** queues, Redis, Kubernetes, microservices, databases, production auth,
multi-tenant plumbing, desktop surface, remote co-browsing.

## 2. Architecture

```
src/
  model/        provider-, surface-, engine-neutral types. Zero dependencies.
  resolution/   PURE: (TargetDescriptor, Observation) -> Resolution. No I/O.
  surface/      perception/action adapter. web/ implemented; desktop/ documented seam.
  agent/        discovery only: bounded observe->decide->act loop + recorder + LLM adapters
  replay/       production path: deterministic executor. Cannot import agent/.
  policy/       allowlist, risk classification, redaction. One choke point.
  session/      live surface + control lease + escalation lifecycle
  evidence/     append-only redacted JSONL + attachments
  store/        versioned filesystem artifact storage
apps/
  target-app/        hostile local CoreBank Teller (framesets, tables, no test IDs, fault injection)
  operator-console/  minimal handoff UI
  cli/               discover | replay | capabilities
```

**Dependency rule (the architecture):**

```
model/       imports nothing
resolution/  imports model only
surface/     imports model only
agent/  -> session, resolution, policy, evidence, store
replay/ -> session, resolution, policy, evidence, store
agent/  X-> replay/          replay/ X-> agent/     (enforced)
```

### The layered surface seam

1. Raw surface (Playwright page / future OS window)
2. Surface-specific perception (`perceive.ts` — DOM + a11y)
3. Normalized `Observation` / `UiNode` (`model/`)
4. Target resolution (`resolution/`, **pure**)
5. Surface action execution (ephemeral refs only)
6. Evidence capture

Web accessibility trees and Windows UIA / macOS AX are **not** the same thing. The claim is
narrower: each can be *adapted* into a common normalized `Observation`, because all three
expose role, name, value and containment. The adaptation cost is real.

### Why resolution is pure

`resolveTarget(descriptor, observation)` is a pure function, not a `Surface` method:

- Determinism is provable — identical observation + descriptor produce identical resolution,
  verifiable offline with no browser.
- Every observation is written to evidence, so a failed replay can be re-resolved from disk.
- The full fallback ladder is unit-tested against recorded JSON fixtures, including hostile
  ones (duplicate names, nested tables, empty labels), with zero Playwright in the test path.
- A future desktop `Surface` inherits the entire resolution engine; it only has to produce
  good `UiNode`s.

Cost: strategies may use only what `UiNode` carries. This is a deliberate forcing function —
enriching the normalized model for *all* surfaces is the sanctioned fix, not special-casing web.

## 3. Key interfaces

### Persistent vs. ephemeral actions

```
StepAction (in the artifact: TargetDescriptor + ValueSource)
  -> resolution.resolveTarget(descriptor, observation)  [pure] -> Ref
  -> bindValue(valueSource, inputs, outputs, credentials) [pure] -> string
  -> ResolvedAction (Ref + literal string)
  -> surface.execute(ResolvedAction)
```

`Surface` never imports `TargetDescriptor`. It cannot resolve, only execute.

```ts
export interface Surface {
  readonly kind: "web" | "desktop";
  observe(): Promise<Observation>;
  execute(action: ResolvedAction): Promise<void>;   // asserts the control lease
  capture(reason: string): Promise<EvidenceRef>;
  instrument(on: boolean): Promise<void>;           // record human actions during handoff
  dispose(): Promise<void>;
}
```

### Observation model

```ts
type Ref = string;                          // opaque; valid only within its Observation

type ScopeSegment =
  | { by:"name";    value: string }
  | { by:"title";   value: string }
  | { by:"urlPath"; value: string }
  | { by:"index";   value: number };        // weak, flagged

interface ScopePath {
  path: ScopeSegment[];                     // outermost -> innermost
  region?: { by:"landmark" | "heading"; value: string };
}

interface UiNode {
  ref: Ref;
  role: string;                             // normalized role vocabulary
  name?: string;                            // accessible name
  value?: string;
  state?: { disabled?, checked?, expanded?, readonly?, required?, visible };
  scope: ScopePath;
  anchors: Anchor[];                        // label | rowHeader | columnHeader | sectionHeading | precedingText
  attrs?: Record<string,string>;            // allowlisted only — never a selector dump
}

interface Observation {
  observationId: string;
  surfaceKind: "web" | "desktop";
  locationHint?: string;                    // canonicalized route / window title
  title?: string;
  screenSignature: string;                  // structural hash — screen identity + drift
  nodes: UiNode[];
  capturedAt: string;
}
```

Refs are ephemeral by design; `TargetDescriptor`s persist. Discovery's job is converting the
former into the latter. The web adapter keeps an ephemeral `ScopePath -> FrameLocator` map per
observation; a desktop adapter would keep `ScopePath -> AutomationElement`. Those maps never
serialize.

### Targeting

```ts
type StrategyKind =
  | "roleAndName"      // role + accessible name
  | "labelled"         // form control by associated label text
  | "anchoredCell"     // table cell by rowKey x columnHeader   <- legacy table layouts
  | "roleInRegion"     // sole node of a role within a named region
  | "ordinalInScope";  // last resort; forces robustness:"weak"

interface TargetDescriptor {
  scope: ScopePath;
  expectedRole: string;                     // checked independently of the strategy
  primary: TargetStrategy;
  fallbacks: TargetStrategy[];              // ordered, max 3
  cardinality: "exactlyOne" | "nth";
  nth?: number;
  rationale: string;                        // required — forces a reviewable justification
}

type Resolution =
  | { ok:true;  ref: Ref; tier: number; strategyUsed: TargetStrategy; attempts: StrategyAttempt[] }
  | { ok:false; reason:"notFound"|"ambiguous"|"roleMismatch"; matchCount: number;
      attempts: StrategyAttempt[] };
```

Ambiguity is a first-class failure: `exactlyOne` with >1 match returns `ok:false`, never an
arbitrary pick. `expectedRole` mismatch is `roleMismatch`, not a false positive.

### Conditions — structured, not stringly-typed

```ts
interface TextMatcher {
  op: "equals" | "contains" | "startsWith" | "regex";   // regex is explicit and greppable
  value: string;
  caseSensitive?: boolean;        // default false
  normalizeWhitespace?: boolean;  // default true
}

type Condition =
  | { kind:"exists";   target }
  | { kind:"absent";   target }
  | { kind:"text";     target; match: TextMatcher }
  | { kind:"value";    target; match: TextMatcher }
  | { kind:"location"; match: TextMatcher }
  | { kind:"all"|"any"; of: LeafCondition[] };          // nesting capped at depth 2
```

One evaluator serves preconditions, checkpoints, outcome detectors and waits.

### LLM seam

```ts
interface LlmClient {
  readonly provider: string; readonly model: string;
  decide(req: DecisionRequest): Promise<AgentDecision>;
}

type AgentDecision =
  | { kind:"act";     ref: Ref; action: ProposedAction; rationale: string }
  | { kind:"extract"; ref: Ref; field: string; as: ValueType; rationale: string }
  | { kind:"done";    summary: string }
  | { kind:"stuck";   reason: string };
```

The model returns a `Ref` — it *points at* a node in the observation it was shown. It cannot
author a selector. Locator robustness is produced by deterministic rules in `recorder.ts`, not
improvised by a language model. Message formatting, tool schema, auth and model config live
inside provider adapters; `createLlmClient()` reads `LLM_PROVIDER` / `LLM_MODEL` /
`<PROVIDER>_API_KEY`.

### Policy — one choke point, both paths

```ts
type RiskClass = "readOnly" | "reversible" | "irreversible";
type PolicyVerdict =
  | { allow:"yes" }
  | { allow:"no";               code: PolicyDenialCode; reason: string }
  | { allow:"withConfirmation"; reason: string };       // -> escalation
```

`irreversible` + `unattended` + `draft` => `withConfirmation` => escalation, never silent
execution. Denial during replay is a hard failure; denial during discovery is fed back to the
model as an observation so it re-plans inside the fence.

### Control lease

```ts
type Holder = "automation" | "operator" | "none";
interface ControlLease {
  holder(): Holder;
  assertHeldBy(who: Holder): void;                  // throws ControlNotHeld
  transfer(from: Holder, to: Holder, reason: string): Promise<void>;
  waitUntilHeldBy(who: Holder, timeoutMs: number): Promise<void>;
  onChange(cb: (e: LeaseChange) => void): void;
}
```

Asserted on **every** `Surface.execute`. Control transfer is enforced, not advisory, and every
transfer is an evidence event.

## 4. Data flows

### Discovery (LLM in the loop, once)

```
cli discover --goal "..." --target http://localhost:4000 --inputs '{"memberId":"100234"}'
  policy.checkNavigation -> session.open -> lease.acquire("automation")
  loop (bounded: maxSteps, wallClock, no-progress detector):
    1. surface.observe()                 -> Observation
    2. policy.redactObservation()        -> values masked before leaving the process
    3. llm.decide()                      -> AgentDecision (provider-neutral)
    4. decision references a UiNode by ref — the model points, never writes a selector
    5. recorder.describe(ref, observation) -> TargetDescriptor by deterministic rules
    6. SELF-VALIDATE: resolveTarget(descriptor, observation) must return the same node,
       uniquely. If not, widen and retry. A descriptor that cannot replay is never recorded.
    7. policy.checkAction() -> deny feeds back to the model; withConfirmation escalates
    8. surface.execute()  [lease asserted]
    9. evidence.event(); capture on transition or anomaly
  done -> recorder.finalize() -> status:"draft" (never auto-approved)
  store.save() -> capabilities/<id>/1.0.0.json ; evidence/<runId>/...
```

Step 6 is the load-bearing one: discovery verifies the recorded target resolves uniquely back
to the intended node *before* committing it.

### Deterministic replay (production path)

```
cli replay <id>@<version> --inputs '{...}'
  1. store.load()            Zod-validated on read
  2. validateInputs()        fail fast -> business_outcome INVALID_INPUT (pre-flight)
  3. policy.gate()           risk class + approval state
  4. session.open(); lease.acquire("automation")
  5. entry + preconditions
  for each step:                                    <- plain iteration, no planner
     a. bind values      (typed ValueSource, not string interpolation)
     b. policy.checkAction   deny -> HARD POLICY_BLOCKED
     c. observe()
     d. resolveTarget()  pure  notFound -> wait/retry ladder -> TARGET_UNRESOLVED
                               ambiguous -> TARGET_AMBIGUOUS (never an arbitrary pick)
                               ok -> records which tier matched
     e. execute()        [lease asserted]
     f. observe()
     g. OUTCOME CHECK    evaluated BEFORE the checkpoint, every step
          business    -> stop, return business_outcome
          recoverable -> bounded declared recovery, then resume directive;
                         budget exhausted -> promoted to hard
          hard        -> escalate or fail
     h. checkpoint assert
     i. evidence.event()
  6. successCheckpoint -> extract typed outputs (deterministic transforms only)
  7. return ReplayResult
```

```ts
type ReplayResult =
  | { status:"success";          outputs; steps; evidenceRef; resolutionReport }
  | { status:"business_outcome"; code; message?; outputs?; evidenceRef }
  | { status:"escalated";        interventionId; resumedBy?; finalStatus?; evidenceRef }
  | { status:"failed";           error:{ stepId; class; code; expected; observed; attempts };
                                 evidenceRef };
```

`business_outcome` is **not** an error arm and does not throw. CLI exit codes: `0` success,
`0` business outcome (code on stdout), `2` escalated, `3` failed.

`resolutionReport` records, per step, which tier matched. Aggregated across runs this is the
drift signal — a step that starts falling through to fallbacks is an app that changed under
you, detectable with no model involved.

### Escalation and handoff

```
automation running (lease.holder === "automation")
  triggers:
    discovery: AgentStuck | NoProgress | MaxSteps | PolicyRequiresConfirmation
    replay:    TargetUnresolved | TargetAmbiguous | CheckpointFailed | UnknownState
               | RecoveryExhausted | RiskyAction
  escalation.raise() -> InterventionRequest { id, runId, mode, capabilityId, goal,
      stepId, stepIntent, reason, expected, observed, observationRef, screenshotRef,
      resumePlan:{ resumeAtStepId, mode:"retryStep"|"continueAfter" } }
  automation PAUSES — same process, same BrowserContext, same page, same cookies
  operator console (localhost:4100): queue -> detail -> [Take control]
      lease.transfer(automation -> operator); surface.instrument(true)
      from here, automation's surface.execute() THROWS ControlNotHeld
  human operates the SAME live window; every action -> evidence human_action event
      (actor, role, accessibleName, actionKind, redacted value)
  [Release & resume] -> lease.transfer(operator -> automation)
  automation RESUMES at resumePlan.resumeAtStepId
      replay re-observes and re-asserts the checkpoint — it does NOT assume the human
      left the state it wanted. Still wrong -> escalate again, bounded.
      discovery folds the human's actions into the step list as provenance:"human".
```

**Real:** the lease and its enforcement, the same-session guarantee, pause/resume, the
intervention record with full context, recording of human actions.
**Mocked deliberately:** remote co-browsing. The operator drives the headed browser on the same
machine. The control-transfer model is unchanged if a streaming console is swapped in later —
which is precisely why the lease is a separate concept from the surface.

## 5. Artifact schema

Persistent, versioned, reviewable data. Not a transcript, not generated code. ~200 lines of Zod.
Deliberately **not** a workflow DSL: no branching, no loops, no expressions, no user-supplied
code, one bounded recovery form, capped nesting everywhere.

```
Capability
  schemaVersion "1.0" | id | version (semver) | title | description
  app { product, productVersion, variant, entry: PathTemplate }
  entryCheckpoint: Condition
  status: draft | in_review | approved | deprecated
  risk:   readOnly | reversible | irreversible
  inputs:  Record<name, InputSpec>
  outputs: Record<name, OutputSpec>
  preconditions: Condition[]        (max 4)
  steps: Step[]                     (1..30)
  successCheckpoint: Condition
  inheritsOutcomesFrom?: "corebank-teller@8"
  outcomes: OutcomeDefinition[]
  escalation { onHardFailure, onUnresolvedTarget, onAmbiguousTarget, onUnknownState,
               operatorTimeoutSeconds }
  provenance { generatedBy, discoveredAt, runId, provider, model, evidenceRunRef, goal,
               llmStepCount, humanStepCount }
  review     { reviewedBy?, reviewedAt?, notes?, weakTargets[] }
```

### Values and actions

```ts
type ValueSource =
  | { from:"input";      name }
  | { from:"literal";    value }        // rejected when the bound input's sensitivity != none
  | { from:"output";     name }
  | { from:"credential"; ref };         // resolved from env at runtime, never persisted

type StepAction =
  | { kind:"click";    target }
  | { kind:"fill";     target; value: ValueSource }
  | { kind:"select";   target; value: ValueSource }
  | { kind:"pressKey"; key; target? }
  | { kind:"wait";     for: Condition; timeoutMs; pollMs }
  | { kind:"navigate"; path: PathTemplate; rationale }   // flagged weak — see below
  | { kind:"dismiss";  target };

interface Step {
  id; intent;                    // intent is prose for review + the escalation card
  action: StepAction;
  checkpoint?: Condition;        // or explicitly null with a reason
  robustness: "strong" | "weak"; robustnessNote?;
  provenance: "llm" | "human" | "reviewer";
}
```

There is exactly **one** way to wait: a step whose action is `{kind:"wait"}`. There is no
step-level wait guard — the same intent expressible two ways is how schemas rot. "Wait for the
spinner to clear, then click" is two steps, which is also what the evidence log should show.

No branching between steps. A flow that needs branching is two capabilities — which keeps
replay a straight loop.

### Navigation semantics

Three cases, explicitly distinguished:

1. **Entry** (`app.entry`) — a `PathTemplate` against a runtime-supplied base URL, executed
   before step 1 and followed by `entryCheckpoint`. Setup, not a step.
2. **`navigate` as a step** — permitted, requires a `rationale`, marked `robustness:"weak"`,
   surfaces in `review.weakTargets`. Deep-linking by URL is the least portable thing across
   tenants running the same vendor product (`/teller/member/{id}` vs `/app/mbr.do?id={id}`).
   Clicking the link survives that; a hardcoded route does not.
3. **Navigation as a side effect of a click** — not represented; it is just the next observation.

**No absolute URL ever appears in an artifact.** Paths and templates only; the base URL arrives
at replay time from tenant config. This is both the multi-tenant seam and a safety property.

### Inputs and outputs

`InputSpec`: type, description, required, optional pattern/enum, `sensitivity`, synthetic
`example`. Doubles as the agent-facing contract — converts mechanically to a JSON-Schema tool
definition for function calling. Validated pre-flight, before a browser opens.

`OutputSpec`: declared type + `source { from: stepId, target, read }` + ordered `Transform[]` +
`sensitivity`. `from` names the step whose post-action observation to read, so extraction can
pull from mid-flow screens.

```ts
type Transform =
  | { kind:"trim" } | { kind:"normalizeWhitespace" }
  | { kind:"stripPrefix"; value } | { kind:"stripSuffix"; value }
  | { kind:"extractGroup"; pattern; group }         // explicit regex
  | { kind:"currencyToNumber"; currency:"USD" }
  | { kind:"toNumber" }
  | { kind:"parseDate"; format:"MM/DD/YYYY"|"YYYY-MM-DD" };
```

Closed union — no eval, no arbitrary JS, no LLM. Results are type-checked against the declared
type; a `required` output that fails extraction is a hard failure carrying the target attempts
and the redacted observed text.

### Outcome model — the boundary

| Concept | What it is | Owner |
|---|---|---|
| Outcome detector | a `Condition` answering "what state am I in?" | artifact (data) |
| Outcome class | `business` / `recoverable` / `hard` — decides what the engine does | artifact (data) |
| Recovery | bounded micro-sequence, only for `recoverable`, plus a resume directive | artifact (data) |
| Step sequence | the normal happy path | artifact (data) |

The replay engine hardcodes **none** of these — only the machinery: evaluate detectors, switch
on class, run declared recovery, count attempts, promote to hard when the budget is spent.

```ts
interface Recovery {
  actions: StepAction[];                      // max 5 — reuses the SAME action union
  verify?: Condition;
  resume: "retryStep" | "continueAfter" | "restart";
  maxAttempts: 1 | 2 | 3;
}
```

Recovery is not a second workflow language: no branching, no loops, no nested outcomes, actions
pass through the policy engine, and the schema rejects a recovery containing an irreversible
action. Budget exhausted or `verify` failing promotes the outcome to `hard`.

Evaluation order is `hard` -> `business` -> `recoverable`, so a permission denial is never
mistaken for a recoverable blip.

**Business outcomes** (`MEMBER_NOT_FOUND`, `INVALID_MEMBER_ID`) stop the run and return
`business_outcome` with exit code 0. The schema forbids `escalate:true` on them.

**Hard failures** come from two sources. Declared: `class:"hard"` outcomes like
`PERMISSION_DENIED`. Structural, raised by the engine with no declaration needed:
`TARGET_UNRESOLVED`, `TARGET_AMBIGUOUS`, `CHECKPOINT_FAILED`, `WAIT_TIMEOUT`,
`EXTRACTION_FAILED`, `POLICY_BLOCKED`, `UNKNOWN_STATE`, `RECOVERY_EXHAUSTED`.

App-wide outcomes (`SESSION_EXPIRED`, `INTERSTITIAL_NOTICE`, `APP_ERROR`) live in a shared
profile (`profiles/corebank-teller@8.json`) inherited via `inheritsOutcomesFrom`. Profile
outcomes load first; artifact outcomes override by `code`. This is the multi-tenant reuse point.

### Safety metadata

- `risk` at capability level; `status` gating unattended execution (`approved` required)
- `sensitivity` on every input and output, driving redaction in logs, evidence, and anything
  sent to the model
- `{from:"credential"}` as the only channel for secrets
- paths not URLs, so no tenant hostname is ever committed
- schema rejects `{from:"literal"}` bound to any input whose sensitivity is not `none` — a
  captured PII value cannot be accidentally baked into a step

### Versioning and lifecycle

`schemaVersion` versions the schema; `version` (semver) versions the capability. Stored at
`capabilities/<id>/<version>.json`, immutable once written. **Patch** = target/fallback/wait
tuning, no contract change. **Minor** = added optional input, added output, added outcome.
**Major** = changed input/output contract or step semantics. Callers pin `@1.0.0` or float `@1`.
Lifecycle `draft -> in_review -> approved -> deprecated`; only `approved` runs unattended.

### Discovery-generated vs. human-reviewed

| Discovery writes | Human owns |
|---|---|
| `steps[]`, all descriptors + fallbacks + rationale, checkpoints, waits, `successCheckpoint`, input/output skeletons, encountered outcomes, `provenance.*`, robustness flags, `status:"draft"` | `status` promotion, `risk` confirmation, `review.*`, sensitivity confirmation, `description`, outcome curation, `{from:"credential"}` wiring |

Discovery never writes `status:"approved"`, never writes a credential reference, and never sets
`risk` below what its recorded actions imply. Provenance is per-step, so a capability partly
authored by an operator during an escalation is honest about it.

### Artifact vs. evidence directory

*In the artifact:* `provenance.evidenceRunRef` (a path), `runId`, counts. **References only.**

*In `/evidence/<runId>/`:* `run.jsonl`, `observations/*.json`, `screenshots/*.png`,
`result.json`, `interventions/*.json`.

Artifacts hold no captured values, no observations, no screenshots, no absolute URLs, no
credentials — so a capability file is safe to commit, review in a PR, and reuse across
institutions. Observations and screenshots contain member data and belong to a *run*, not to a
capability.

### Required for deterministic replay

Minimum: `id`, `version`, `app.entry`, `entryCheckpoint`, `inputs`, `outputs`,
`steps[].{id, action}`, `successCheckpoint`, `escalation`, `status`, `risk`.

Enforced by `assertReplayable` at parse time:

- every `{from:"input"}` names a declared input; every `{from:"output"}` names an output
  extracted at an earlier step
- every `OutputSpec.source.from` names a real step id
- every `outcomes[].scope.steps[]` names real step ids
- no `{from:"literal"}` bound to a control whose input sensitivity is not `none`
- no irreversible action inside a `Recovery`
- at most one outcome per `code` after profile merge
- every step has a `checkpoint`, or `checkpoint: null` with a stated reason

An artifact failing these does not load. Invalid capabilities fail at parse, not mid-run against
a live banking screen.

## 6. Target application

`apps/target-app/` — "CoreBank Teller", server-rendered, deliberately hostile:

- iframe/frameset layout (nav frame + content frame)
- table-based layouts, no test IDs, non-semantic class names
- full-page form posts, server-side validation
- `<label for>` relationships present (so `labelled` targeting is meaningful)
- incidental DOM structure that shifts between renders

Flows: member search -> results -> member detail (accounts table) -> read balance.

Injectable faults via a control endpoint: record-not-found, validation error, unexpected
interstitial dialog, session timeout, permission denial, transient slow load, app error.

A second variant skin (different labels/branding/routes, same vendor product) stands in for a
second tenant. Capped in scope — if it starts growing, it gets cut, not extended.

## 7. Trade-offs

**Pure resolution buys provable determinism, costs model richness.** Strategies see only
normalized `UiNode` fields; a DOM-specific shortcut is unavailable unless promoted into the
normalized model for every surface. Accepted: the target environment has no stable IDs, and
testability plus desktop portability are worth more than the shortcut.

**Semantic targeting is weaker than a good test ID and stronger than everything else
available.** Those apps do not exist here. Against table layouts and non-semantic markup,
role + accessible name + anchoring degrades gracefully where XPath shatters. `anchoredCell`
(row-key x column-header) is the honest answer for unnameable legacy controls;
`ordinalInScope` is the last resort the artifact *flags as weak* so a reviewer sees the risk
before production does.

**Outcomes as data means an incomplete outcome table looks like a hard failure.** An undeclared
condition stops the run with `UNKNOWN_STATE` and escalates. That is correct for a regulated
system: "I encountered something I do not understand" must halt, not improvise. The cost is
that artifacts need curation as new conditions surface — which is the review loop the outcome
table is designed to support.

**A local target app costs build time and buys the entire error taxonomy.** A public demo site
is free but happy-path only; you cannot inject a session timeout into someone else's site.

**Refusing to let the model author locators makes discovery slightly more likely to fail and
replay much more likely to succeed.** The model points; deterministic rules describe.
Occasionally the rules produce a descriptor that will not resolve uniquely and the step is
re-attempted. A discovery-time cost paid once, against every replay thereafter.

**Single process, filesystem, synchronous CLI.** The seams that would matter later
(`CapabilityStore`, `EvidenceSink`, `LlmClient`, `Surface`) are interfaces, so the swap is
mechanical if ever wanted.

**Groq's fast models are text-only in this loop.** The agent decides from the normalized
observation, not pixels; screenshots are evidence and escalation context. Vision would help on
a canvas-rendered surface, and that is a `Surface` / `DecisionRequest` extension rather than a
redesign.

**The operator console is local-only.** Real lease, real same-session control, real recording
of human actions; no remote streaming.

## 8. Deliverables

- `/README.md` — setup, config, and the exact demo path (discover, then replay)
- `/REPORT.md` — seven prescribed headings: Architecture, Artifact schema, Determinism & error
  handling, Heterogeneity & multi-tenant, Escalation & handoff, Safety, Cuts
- `/evidence/` — saved artifact, discovery run log, successful replay log, at least one
  exceptional-state replay, screenshots, observation snapshots
- `/capabilities/` — the saved capability artifact and the shared app profile
