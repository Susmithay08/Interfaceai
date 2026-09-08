# Computer-Use Automation System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a system where an LLM discovers how to complete a natural-language goal in a real UI, the successful run is recorded as a typed capability artifact, and that artifact replays deterministically with no model in the loop — with policy guardrails, an error taxonomy, and human escalation on the same live session.

**Architecture:** Single Node/TypeScript process. A neutral `model/` layer defines the vocabulary; a **pure** `resolution/` layer turns a persistent `TargetDescriptor` plus a normalized `Observation` into exactly one element ref; `surface/` adapts Playwright into that normalized `Observation` and executes ephemeral resolved actions. `agent/` (discovery, LLM in the loop) and `replay/` (production, no LLM) both drive the same surface through the same `policy/` choke point. `replay/` is structurally forbidden from importing `agent/`.

**Tech Stack:** TypeScript 5.7 (Node 24, ESM), Zod 3, Playwright 1.49, Vitest 2, Express 4 (target app + operator console), Groq SDK (`groq-sdk`), `commander` (CLI), `eslint-plugin-boundaries`.

**Spec:** `docs/superpowers/specs/2026-09-08-computer-use-automation-design.md` — read it before starting. The plan argues from the spec; where the plan is terse the spec is authoritative.

## Global Constraints

- **Node 24+, ESM only.** `"type": "module"` in package.json; all relative imports carry the `.js` extension.
- **`src/model/` imports nothing** outside itself and `zod`. No Playwright, no Node builtins, no provider SDKs.
- **`src/resolution/` is pure.** No `async`, no I/O, no imports outside `src/model/`. Every function is synchronous and total.
- **`src/replay/` must never import `src/agent/`** and vice versa. Enforced by `eslint-plugin-boundaries` (Task 1) and by an executable module-graph test (Task 17).
- **`src/surface/` must never import `src/resolution/`.** The surface cannot resolve, only observe and execute.
- **No absolute URLs in artifacts.** Only `PathTemplate` paths beginning `/`. Base URL is supplied at runtime.
- **No secrets, credentials, raw PII, observations, or screenshots inside artifacts.** Artifacts hold references only.
- **Redaction happens at the evidence sink**, never at call sites.
- **Every `Surface.execute` asserts the control lease.**
- **TDD.** Test first, watch it fail, minimal implementation, watch it pass, commit. Every task ends green.
- **Test commands:** `npm test` (all), `npx vitest run <path>` (one file), `npx vitest run -t "<name>"` (one test).
- **Fixed identifiers used across tasks** (do not rename):
  `resolveTarget`, `evaluateCondition`, `matchText`, `applyTransforms`, `bindValue`, `matchStrategy`,
  `PlaywrightWebSurface`, `ControlLease`, `EvidenceSink`, `CapabilityStore`, `PolicyEngine`,
  `ReplayEngine.replay`, `DiscoveryLoop.discover`, `describeTarget`, `finalizeCapability`, `LlmClient.decide`.

---

## File Structure

```
package.json  tsconfig.json  vitest.config.ts  eslint.config.js  .env.example
src/
  model/
    ids.ts            Ref, StepId, brand types
    observation.ts    ScopeSegment, ScopePath, Anchor, UiNode, Observation
    target.ts         StrategyKind, TargetStrategy, TargetDescriptor, StrategyAttempt, Resolution
    condition.ts      TextMatcher, Condition, ConditionResult
    action.ts         ValueSource, PathTemplate, StepAction, ResolvedAction, KeyName
    transform.ts      Transform
    outcome.ts        OutcomeClass, OutcomeDefinition, Recovery, AppProfile
    capability.ts     Zod: Capability, InputSpec, OutputSpec, Step + assertReplayable
    result.ts         ReplayResult, StepTrace, FailureCode, ResolutionReport
    evidence.ts       RunEvent union, EvidenceRef
    escalation.ts     InterventionRequest, EscalationReason, Holder, LeaseChange
  resolution/
    strategies.ts     matchStrategy — the five strategy kinds
    resolve-target.ts resolveTarget — ladder, cardinality, role check
    evaluate.ts       evaluateCondition, matchText
    extract.ts        applyTransforms, readNode, extractOutput
    bind.ts           bindValue
  surface/
    surface.ts        interface Surface
    web/
      perceive.ts     browser-side DOM+a11y walk -> RawNode[]; Node-side -> Observation
      playwright-surface.ts
      instrument.ts   in-page human-action recorder
    desktop/README.md documented seam, not implemented
  policy/
    policy.config.ts  the allowlist (data)
    risk.ts           classifyAction
    redaction.ts      redactValue, redactObservation, redactEvent
    policy-engine.ts  PolicyEngine
  session/
    control-lease.ts  ControlLease
    escalation.ts     EscalationService
    session.ts        Session (surface + lease + evidence)
  evidence/
    sink.ts           FileEvidenceSink
  store/
    capability-store.ts  FileCapabilityStore + profile merge
  replay/
    waiter.ts         waitFor
    outcome-checker.ts checkOutcomes
    replay-engine.ts  ReplayEngine
  agent/
    llm/
      llm-client.ts   LlmClient, DecisionRequest, AgentDecision
      prompt.ts       buildPrompt, parseDecision
      providers/groq.ts, anthropic.ts, openai.ts, index.ts (createLlmClient)
    recorder.ts       describeTarget, finalizeCapability
    discovery-loop.ts DiscoveryLoop
apps/
  target-app/         server.ts, state.ts, faults.ts, views/*.html
  operator-console/   server.ts, ui.html
  cli/                index.ts, discover.ts, replay.ts, capabilities.ts
tests/
  fixtures/observations/*.json
  unit/... integration/... e2e/...
capabilities/  evidence/  profiles/
```

---

## Task 1: Project scaffold and neutral model types

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.env.example`
- Create: `src/model/ids.ts`, `src/model/observation.ts`, `src/model/target.ts`, `src/model/condition.ts`, `src/model/action.ts`, `src/model/transform.ts`
- Test: `tests/unit/model/observation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: every type named in the spec's §3. Exact shapes below — later tasks import these verbatim.

- [ ] **Step 1: Initialise the project**

```bash
cd "D:/Interface ai"
npm init -y
npm pkg set type=module name=corebank-capability-engine version=0.1.0
npm i zod@^3.24 playwright@^1.49 express@^4.21 commander@^12 groq-sdk@^0.9 nanoid@^5
npm i -D typescript@^5.7 vitest@^2.1 @types/node@^22 @types/express@^4 tsx@^4 \
        eslint@^9 typescript-eslint@^8 eslint-plugin-boundaries@^5
npx playwright install chromium
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true, "verbatimModuleSyntax": true,
    "outDir": "dist", "rootDir": ".", "skipLibCheck": true, "types": ["node"]
  },
  "include": ["src/**/*", "apps/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Write `vitest.config.ts` and npm scripts**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], environment: "node", testTimeout: 30_000 },
});
```

```bash
npm pkg set scripts.test="vitest run" scripts.typecheck="tsc --noEmit" \
  scripts.lint="eslint ." scripts.cli="tsx apps/cli/index.ts" \
  scripts.target-app="tsx apps/target-app/server.ts" \
  scripts.operator="tsx apps/operator-console/server.ts"
```

- [ ] **Step 4: Write `eslint.config.js` enforcing the dependency rule**

```js
import boundaries from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";

export default tseslint.config({
  files: ["src/**/*.ts"],
  plugins: { boundaries },
  settings: {
    "boundaries/elements": [
      { type: "model",      pattern: "src/model/*" },
      { type: "resolution", pattern: "src/resolution/*" },
      { type: "surface",    pattern: "src/surface/**/*" },
      { type: "policy",     pattern: "src/policy/*" },
      { type: "session",    pattern: "src/session/*" },
      { type: "evidence",   pattern: "src/evidence/*" },
      { type: "store",      pattern: "src/store/*" },
      { type: "agent",      pattern: "src/agent/**/*" },
      { type: "replay",     pattern: "src/replay/*" },
    ],
  },
  rules: {
    "boundaries/element-types": ["error", {
      default: "disallow",
      rules: [
        { from: "model",      allow: ["model"] },
        { from: "resolution", allow: ["model"] },
        { from: "surface",    allow: ["model"] },
        { from: "policy",     allow: ["model"] },
        { from: "evidence",   allow: ["model", "policy"] },
        { from: "store",      allow: ["model"] },
        { from: "session",    allow: ["model", "surface", "evidence"] },
        { from: "agent",      allow: ["model","resolution","surface","policy","session","evidence","store"] },
        { from: "replay",     allow: ["model","resolution","surface","policy","session","evidence","store"] },
      ],
    }],
  },
});
```

`agent` is absent from `replay`'s allow-list and vice versa. This is the through-line, mechanically enforced.

- [ ] **Step 5: Write `.env.example`**

```
LLM_PROVIDER=groq
LLM_MODEL=llama-3.3-70b-versatile
GROQ_API_KEY=
TARGET_BASE_URL=http://localhost:4000
OPERATOR_CONSOLE_PORT=4100
COREBANK_TELLER_USERNAME=demo.teller
COREBANK_TELLER_PASSWORD=demo-pass-not-real
```

- [ ] **Step 6: Write the failing test**

`tests/unit/model/observation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { scopeKey, sameScope } from "../../../src/model/observation.js";
import type { ScopePath } from "../../../src/model/observation.js";

const content: ScopePath = { path: [{ by: "name", value: "content" }] };
const contentAccounts: ScopePath = {
  path: [{ by: "name", value: "content" }],
  region: { by: "heading", value: "Accounts" },
};

describe("scopeKey", () => {
  it("is stable and distinguishes region", () => {
    expect(scopeKey(content)).toBe("name:content");
    expect(scopeKey(contentAccounts)).toBe("name:content|region:heading:Accounts");
  });
});

describe("sameScope", () => {
  it("treats a node in a region as inside the region-less parent scope", () => {
    expect(sameScope(contentAccounts, content)).toBe(true);   // node scope, target scope
  });
  it("rejects a node outside the required region", () => {
    expect(sameScope(content, contentAccounts)).toBe(false);
  });
  it("rejects a different frame", () => {
    const nav: ScopePath = { path: [{ by: "name", value: "nav" }] };
    expect(sameScope(nav, content)).toBe(false);
  });
});
```

- [ ] **Step 7: Run it and confirm it fails**

Run: `npx vitest run tests/unit/model/observation.test.ts`
Expected: FAIL — `Failed to resolve import ".../src/model/observation.js"`.

- [ ] **Step 8: Write `src/model/ids.ts`**

```ts
export type Ref = string & { readonly __brand: "Ref" };
export const asRef = (s: string): Ref => s as Ref;
export type StepId = string;
```

- [ ] **Step 9: Write `src/model/observation.ts`**

```ts
export type ScopeSegment =
  | { readonly by: "name";    readonly value: string }
  | { readonly by: "title";   readonly value: string }
  | { readonly by: "urlPath"; readonly value: string }
  | { readonly by: "index";   readonly value: number };

export interface ScopeRegion { readonly by: "landmark" | "heading"; readonly value: string }

export interface ScopePath {
  readonly path: readonly ScopeSegment[];
  readonly region?: ScopeRegion;
}

export type AnchorKind =
  | "label" | "rowHeader" | "columnHeader" | "sectionHeading" | "precedingText";
export interface Anchor { readonly kind: AnchorKind; readonly text: string }

export interface NodeState {
  readonly visible: boolean;
  readonly disabled?: boolean;  readonly checked?: boolean;
  readonly expanded?: boolean;  readonly readonly?: boolean; readonly required?: boolean;
}

import type { Ref } from "./ids.js";

export interface UiNode {
  readonly ref: Ref;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly state: NodeState;
  readonly scope: ScopePath;
  readonly anchors: readonly Anchor[];
  readonly attrs?: Readonly<Record<string, string>>;
}

export interface Observation {
  readonly observationId: string;
  readonly surfaceKind: "web" | "desktop";
  readonly locationHint?: string;
  readonly title?: string;
  readonly screenSignature: string;
  readonly nodes: readonly UiNode[];
  readonly capturedAt: string;
}

export function scopeKey(s: ScopePath): string {
  const frames = s.path.map((seg) => `${seg.by}:${seg.value}`).join(">");
  return s.region ? `${frames}|region:${s.region.by}:${s.region.value}` : frames;
}

/** Is `node` inside `target`? A node in a region is inside the region-less parent scope. */
export function sameScope(node: ScopePath, target: ScopePath): boolean {
  if (node.path.length !== target.path.length) return false;
  for (let i = 0; i < target.path.length; i++) {
    const a = node.path[i], b = target.path[i];
    if (!a || !b || a.by !== b.by || a.value !== b.value) return false;
  }
  if (!target.region) return true;
  return node.region?.by === target.region.by && node.region?.value === target.region.value;
}
```

- [ ] **Step 10: Write `src/model/target.ts`**

```ts
import type { Ref } from "./ids.js";
import type { ScopePath } from "./observation.js";

export type StrategyKind =
  | "roleAndName" | "labelled" | "anchoredCell" | "roleInRegion" | "ordinalInScope";
export type MatchMode = "exact" | "normalized" | "prefix";

export interface TargetStrategy {
  readonly kind: StrategyKind;
  readonly params: Readonly<Record<string, string | number>>;
  readonly match?: MatchMode;              // default "normalized"
}

export interface TargetDescriptor {
  readonly scope: ScopePath;
  readonly expectedRole: string;
  readonly primary: TargetStrategy;
  readonly fallbacks: readonly TargetStrategy[];
  readonly cardinality: "exactlyOne" | "nth";
  readonly nth?: number;
  readonly rationale: string;
}

export type AttemptOutcome = "matched" | "noMatch" | "ambiguous" | "roleMismatch";
export interface StrategyAttempt {
  readonly strategy: TargetStrategy;
  readonly tier: number;                   // 0 = primary
  readonly matchCount: number;
  readonly outcome: AttemptOutcome;
}

export type Resolution =
  | { readonly ok: true;  readonly ref: Ref; readonly tier: number;
      readonly strategyUsed: TargetStrategy; readonly attempts: readonly StrategyAttempt[] }
  | { readonly ok: false; readonly reason: "notFound" | "ambiguous" | "roleMismatch";
      readonly matchCount: number; readonly attempts: readonly StrategyAttempt[] };
```

- [ ] **Step 11: Write `src/model/condition.ts`**

```ts
import type { TargetDescriptor } from "./target.js";

export interface TextMatcher {
  readonly op: "equals" | "contains" | "startsWith" | "regex";
  readonly value: string;
  readonly caseSensitive?: boolean;        // default false
  readonly normalizeWhitespace?: boolean;  // default true
}

export type LeafCondition =
  | { readonly kind: "exists";   readonly target: TargetDescriptor }
  | { readonly kind: "absent";   readonly target: TargetDescriptor }
  | { readonly kind: "text";     readonly target: TargetDescriptor; readonly match: TextMatcher }
  | { readonly kind: "value";    readonly target: TargetDescriptor; readonly match: TextMatcher }
  | { readonly kind: "location"; readonly match: TextMatcher };

export type Condition =
  | LeafCondition
  | { readonly kind: "all"; readonly of: readonly LeafCondition[] }
  | { readonly kind: "any"; readonly of: readonly LeafCondition[] };

export interface ConditionResult {
  readonly passed: boolean;
  readonly observed?: string;      // what was actually found — redacted before it reaches evidence
  readonly detail: string;         // human-readable "why", for failure reporting
}
```

- [ ] **Step 12: Write `src/model/transform.ts` and `src/model/action.ts`**

```ts
// transform.ts
export type Transform =
  | { readonly kind: "trim" }
  | { readonly kind: "normalizeWhitespace" }
  | { readonly kind: "stripPrefix";      readonly value: string }
  | { readonly kind: "stripSuffix";      readonly value: string }
  | { readonly kind: "extractGroup";     readonly pattern: string; readonly group: number }
  | { readonly kind: "currencyToNumber"; readonly currency: "USD" }
  | { readonly kind: "toNumber" }
  | { readonly kind: "parseDate";        readonly format: "MM/DD/YYYY" | "YYYY-MM-DD" };
```

```ts
// action.ts
import type { Ref } from "./ids.js";
import type { TargetDescriptor } from "./target.js";
import type { Condition } from "./condition.js";

export type KeyName = "Enter" | "Tab" | "Escape" | "ArrowDown" | "ArrowUp";

export type ValueSource =
  | { readonly from: "input";      readonly name: string }
  | { readonly from: "literal";    readonly value: string }
  | { readonly from: "output";     readonly name: string }
  | { readonly from: "credential"; readonly ref: string };

export interface PathTemplate {
  readonly path: string;                                   // must start with "/"
  readonly params?: Readonly<Record<string, ValueSource>>;
}

/** Persistent — appears in artifacts. Carries TargetDescriptors. */
export type StepAction =
  | { readonly kind: "click";    readonly target: TargetDescriptor }
  | { readonly kind: "fill";     readonly target: TargetDescriptor; readonly value: ValueSource }
  | { readonly kind: "select";   readonly target: TargetDescriptor; readonly value: ValueSource }
  | { readonly kind: "pressKey"; readonly key: KeyName; readonly target?: TargetDescriptor }
  | { readonly kind: "wait";     readonly for: Condition;
      readonly timeoutMs: number; readonly pollMs: number }
  | { readonly kind: "navigate"; readonly path: PathTemplate; readonly rationale: string }
  | { readonly kind: "dismiss";  readonly target: TargetDescriptor };

/** Ephemeral — never serialized. Carries refs. The Surface only ever sees this. */
export type ResolvedAction =
  | { readonly kind: "click";    readonly ref: Ref }
  | { readonly kind: "fill";     readonly ref: Ref; readonly value: string }
  | { readonly kind: "select";   readonly ref: Ref; readonly value: string }
  | { readonly kind: "pressKey"; readonly key: KeyName; readonly ref?: Ref }
  | { readonly kind: "navigate"; readonly url: string }
  | { readonly kind: "dismiss";  readonly ref: Ref };

export type ActionKind = StepAction["kind"];
```

- [ ] **Step 13: Run the test and confirm it passes**

Run: `npx vitest run tests/unit/model/observation.test.ts` — Expected: 4 passed.
Run: `npm run typecheck` — Expected: no errors.
Run: `npm run lint` — Expected: no errors.

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "feat(model): project scaffold, neutral types, and enforced module boundaries"
```

---

## Task 2: Observation fixtures for the hostile surface

**Files:**
- Create: `tests/fixtures/observations/member-search.json`, `search-results.json`, `member-detail.json`, `not-found.json`, `validation-error.json`, `session-expired.json`, `ambiguous-buttons.json`
- Create: `tests/fixtures/load.ts`
- Test: `tests/unit/fixtures.test.ts`

**Interfaces:**
- Consumes: `Observation` (Task 1).
- Produces: `loadObservation(name: string): Observation` — used by every `resolution/` test.

These fixtures are the backbone of the determinism claim: resolution is tested against recorded JSON with no browser anywhere in the test path.

- [ ] **Step 1: Write the failing test**

`tests/unit/fixtures.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadObservation, FIXTURE_NAMES } from "../fixtures/load.js";

describe("observation fixtures", () => {
  it.each(FIXTURE_NAMES)("%s is a well-formed observation", (name) => {
    const o = loadObservation(name);
    expect(o.nodes.length).toBeGreaterThan(0);
    expect(new Set(o.nodes.map((n) => n.ref)).size).toBe(o.nodes.length); // refs unique
    for (const n of o.nodes) expect(n.role).toBeTruthy();
  });

  it("member-detail contains an Accounts table with a Savings row", () => {
    const o = loadObservation("member-detail");
    const cells = o.nodes.filter((n) => n.role === "cell");
    expect(cells.some((c) => c.anchors.some((a) => a.kind === "rowHeader" && a.text === "Savings")))
      .toBe(true);
  });

  it("ambiguous-buttons has two identically named Search buttons", () => {
    const o = loadObservation("ambiguous-buttons");
    expect(o.nodes.filter((n) => n.role === "button" && n.name === "Search")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/fixtures.test.ts` — Expected: FAIL, cannot resolve `../fixtures/load.js`.

- [ ] **Step 3: Write `tests/fixtures/load.ts`**

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Observation } from "../../src/model/observation.js";

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_NAMES = [
  "member-search", "search-results", "member-detail",
  "not-found", "validation-error", "session-expired", "ambiguous-buttons",
] as const;

export function loadObservation(name: string): Observation {
  return JSON.parse(readFileSync(join(here, "observations", `${name}.json`), "utf8")) as Observation;
}
```

- [ ] **Step 4: Write `tests/fixtures/observations/member-detail.json`**

Model it on the hostile app: everything inside the `content` frame, the accounts table exposed as `cell` nodes carrying `rowHeader` and `columnHeader` anchors, and a `heading` inside the `Accounts` region.

```json
{
  "observationId": "obs_detail_1",
  "surfaceKind": "web",
  "locationHint": "/teller/member/100234",
  "title": "CoreBank Teller - Member Detail",
  "screenSignature": "sig_member_detail_v8",
  "capturedAt": "2026-09-08T11:42:11Z",
  "nodes": [
    { "ref": "n1", "role": "heading", "name": "Member: Dana Whitfield",
      "state": { "visible": true },
      "scope": { "path": [{ "by": "name", "value": "content" }],
                 "region": { "by": "heading", "value": "Member Detail" } },
      "anchors": [] },
    { "ref": "n2", "role": "table", "name": "Accounts",
      "state": { "visible": true },
      "scope": { "path": [{ "by": "name", "value": "content" }],
                 "region": { "by": "heading", "value": "Accounts" } },
      "anchors": [] },
    { "ref": "n3", "role": "cell", "value": "Savings",
      "state": { "visible": true },
      "scope": { "path": [{ "by": "name", "value": "content" }],
                 "region": { "by": "heading", "value": "Accounts" } },
      "anchors": [{ "kind": "rowHeader", "text": "Savings" },
                  { "kind": "columnHeader", "text": "Account Type" }] },
    { "ref": "n4", "role": "cell", "value": "*******4417",
      "state": { "visible": true },
      "scope": { "path": [{ "by": "name", "value": "content" }],
                 "region": { "by": "heading", "value": "Accounts" } },
      "anchors": [{ "kind": "rowHeader", "text": "Savings" },
                  { "kind": "columnHeader", "text": "Account" }] },
    { "ref": "n5", "role": "cell", "value": "$4,182.55",
      "state": { "visible": true },
      "scope": { "path": [{ "by": "name", "value": "content" }],
                 "region": { "by": "heading", "value": "Accounts" } },
      "anchors": [{ "kind": "rowHeader", "text": "Savings" },
                  { "kind": "columnHeader", "text": "Current Balance" }] },
    { "ref": "n6", "role": "cell", "value": "$912.10",
      "state": { "visible": true },
      "scope": { "path": [{ "by": "name", "value": "content" }],
                 "region": { "by": "heading", "value": "Accounts" } },
      "anchors": [{ "kind": "rowHeader", "text": "Checking" },
                  { "kind": "columnHeader", "text": "Current Balance" }] }
  ]
}
```

Note `n5` and `n6` differ only by row anchor — this is the case `anchoredCell` exists to solve, and the test that proves row anchoring works.

- [ ] **Step 5: Write the remaining six fixtures**

- `member-search.json` — `textbox` with `{kind:"label", text:"Member ID"}` anchor in the `Member Search` region; a `button` named `Search`; a `nav` frame node so cross-frame rejection is testable.
- `search-results.json` — a `table` in the `Search Results` region; `link` nodes named `100234` and `100999`, each with a `rowHeader` anchor of their member id and a `columnHeader` anchor of `Member`.
- `not-found.json` — a `status` node in the `Search Results` region with `value: "No matching member for that ID."`
- `validation-error.json` — an `alert` node in the `Member Search` region with `value: "Member ID must be 6 digits."`
- `session-expired.json` — `textbox` nodes labelled `User ID` and `Password`, plus a `button` named `Sign On`.
- `ambiguous-buttons.json` — two `button` nodes both named `Search` in the same scope, to prove ambiguity is detected rather than silently resolved.

- [ ] **Step 6: Run the test and confirm it passes**

Run: `npx vitest run tests/unit/fixtures.test.ts` — Expected: 9 passed.

- [ ] **Step 7: Commit**

```bash
git add tests/fixtures
git commit -m "test(fixtures): recorded observations for the hostile CoreBank surface"
```

---

## Task 3: Strategy matching

**Files:**
- Create: `src/resolution/strategies.ts`
- Test: `tests/unit/resolution/strategies.test.ts`

**Interfaces:**
- Consumes: `UiNode`, `Observation`, `ScopePath`, `sameScope` (Task 1); fixtures (Task 2).
- Produces: `matchStrategy(s: TargetStrategy, scope: ScopePath, o: Observation): UiNode[]` — returns **all** nodes matching, in observation order. Role checking is deliberately *not* done here; `resolveTarget` does it so `roleMismatch` is distinguishable from `noMatch`.
- Produces: `normalizeText(s: string): string`, `textEquals(a, b, mode: MatchMode): boolean`.

- [ ] **Step 1: Write the failing test**

`tests/unit/resolution/strategies.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { matchStrategy } from "../../../src/resolution/strategies.js";
import { loadObservation } from "../../fixtures/load.js";
import type { ScopePath } from "../../../src/model/observation.js";

const content: ScopePath = { path: [{ by: "name", value: "content" }] };
const accounts: ScopePath = {
  path: [{ by: "name", value: "content" }],
  region: { by: "heading", value: "Accounts" },
};

describe("roleAndName", () => {
  it("matches a button by role and accessible name", () => {
    const o = loadObservation("member-search");
    const hits = matchStrategy({ kind: "roleAndName", params: { role: "button", name: "Search" } }, content, o);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.role).toBe("button");
  });

  it("returns every match when the name is ambiguous", () => {
    const o = loadObservation("ambiguous-buttons");
    const hits = matchStrategy({ kind: "roleAndName", params: { role: "button", name: "Search" } }, content, o);
    expect(hits).toHaveLength(2);
  });

  it("honours prefix matching", () => {
    const o = loadObservation("member-detail");
    const hits = matchStrategy(
      { kind: "roleAndName", params: { role: "heading", name: "Member:" }, match: "prefix" }, content, o);
    expect(hits).toHaveLength(1);
  });
});

describe("labelled", () => {
  it("matches a control by its associated label", () => {
    const o = loadObservation("member-search");
    const hits = matchStrategy({ kind: "labelled", params: { label: "Member ID" } }, content, o);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.role).toBe("textbox");
  });
});

describe("anchoredCell", () => {
  it("selects the cell at rowKey x columnHeader", () => {
    const o = loadObservation("member-detail");
    const hits = matchStrategy(
      { kind: "anchoredCell", params: { rowKey: "Savings", columnHeader: "Current Balance" } },
      accounts, o);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.value).toBe("$4,182.55");   // not the Checking row
  });

  it("returns nothing when the row does not exist", () => {
    const o = loadObservation("member-detail");
    expect(matchStrategy(
      { kind: "anchoredCell", params: { rowKey: "Money Market", columnHeader: "Current Balance" } },
      accounts, o)).toHaveLength(0);
  });
});

describe("roleInRegion", () => {
  it("matches the sole node of a role inside a region", () => {
    const o = loadObservation("member-detail");
    const hits = matchStrategy({ kind: "roleInRegion", params: { region: "Accounts", role: "table" } },
      { path: [{ by: "name", value: "content" }] }, o);
    expect(hits).toHaveLength(1);
  });
});

describe("scope isolation", () => {
  it("never matches a node in a different frame", () => {
    const o = loadObservation("member-search");
    const nav: ScopePath = { path: [{ by: "name", value: "nav" }] };
    expect(matchStrategy({ kind: "roleAndName", params: { role: "button", name: "Search" } }, nav, o))
      .toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/unit/resolution/strategies.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/resolution/strategies.ts`**

```ts
import type { Observation, ScopePath, UiNode } from "../model/observation.js";
import { sameScope } from "../model/observation.js";
import type { MatchMode, TargetStrategy } from "../model/target.js";

export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function textEquals(actual: string | undefined, expected: string, mode: MatchMode = "normalized"): boolean {
  if (actual === undefined) return false;
  if (mode === "exact") return actual === expected;
  const a = normalizeText(actual).toLowerCase();
  const b = normalizeText(expected).toLowerCase();
  return mode === "prefix" ? a.startsWith(b) : a === b;
}

const anchorText = (n: UiNode, kind: string): string[] =>
  n.anchors.filter((a) => a.kind === kind).map((a) => a.text);

const str = (p: Readonly<Record<string, string | number>>, k: string): string => String(p[k] ?? "");

/** All nodes in `scope` matching `s`, in observation order. Role is checked by resolveTarget. */
export function matchStrategy(s: TargetStrategy, scope: ScopePath, o: Observation): UiNode[] {
  const mode = s.match ?? "normalized";
  const inScope = o.nodes.filter((n) => sameScope(n.scope, scope));

  switch (s.kind) {
    case "roleAndName":
      return inScope.filter((n) => n.role === str(s.params, "role")
        && textEquals(n.name, str(s.params, "name"), mode));

    case "labelled":
      return inScope.filter((n) =>
        anchorText(n, "label").some((t) => textEquals(t, str(s.params, "label"), mode)));

    case "anchoredCell":
      return inScope.filter((n) =>
        anchorText(n, "rowHeader").some((t) => textEquals(t, str(s.params, "rowKey"), mode)) &&
        anchorText(n, "columnHeader").some((t) => textEquals(t, str(s.params, "columnHeader"), mode)));

    case "roleInRegion": {
      const region = str(s.params, "region");
      return o.nodes.filter((n) =>
        sameScope(n.scope, { ...scope, region: { by: n.scope.region?.by ?? "heading", value: region } })
        && n.scope.region?.value === region
        && n.role === str(s.params, "role"));
    }

    case "ordinalInScope": {
      const hits = inScope.filter((n) => n.role === str(s.params, "role"));
      const idx = Number(s.params["index"] ?? 0);
      const hit = hits[idx];
      return hit ? [hit] : [];
    }
  }
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npx vitest run tests/unit/resolution/strategies.test.ts` — Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/resolution/strategies.ts tests/unit/resolution/strategies.test.ts
git commit -m "feat(resolution): five semantic targeting strategies, pure and fixture-tested"
```

---

## Task 4: `resolveTarget` — the fallback ladder

**Files:**
- Create: `src/resolution/resolve-target.ts`
- Test: `tests/unit/resolution/resolve-target.test.ts`

**Interfaces:**
- Consumes: `matchStrategy` (Task 3), `TargetDescriptor`, `Resolution` (Task 1).
- Produces: `resolveTarget(t: TargetDescriptor, o: Observation): Resolution` — synchronous, total, no throw.

- [ ] **Step 1: Write the failing test**

`tests/unit/resolution/resolve-target.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveTarget } from "../../../src/resolution/resolve-target.js";
import { loadObservation } from "../../fixtures/load.js";
import type { TargetDescriptor } from "../../../src/model/target.js";

const content = { path: [{ by: "name", value: "content" }] } as const;

const searchButton = (over: Partial<TargetDescriptor> = {}): TargetDescriptor => ({
  scope: content, expectedRole: "button",
  primary: { kind: "roleAndName", params: { role: "button", name: "Search" } },
  fallbacks: [], cardinality: "exactlyOne",
  rationale: "Sole submit control in the search region.", ...over,
});

describe("resolveTarget", () => {
  it("resolves via the primary strategy and reports tier 0", () => {
    const r = resolveTarget(searchButton(), loadObservation("member-search"));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.tier).toBe(0); expect(r.attempts).toHaveLength(1); }
  });

  it("falls through to a fallback and reports the tier that matched", () => {
    const t = searchButton({
      primary: { kind: "roleAndName", params: { role: "button", name: "Find Member" } },
      fallbacks: [{ kind: "roleInRegion", params: { region: "Member Search", role: "button" } }],
    });
    const r = resolveTarget(t, loadObservation("member-search"));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.tier).toBe(1); expect(r.attempts[0]!.outcome).toBe("noMatch"); }
  });

  it("returns ambiguous rather than picking arbitrarily", () => {
    const r = resolveTarget(searchButton(), loadObservation("ambiguous-buttons"));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.reason).toBe("ambiguous"); expect(r.matchCount).toBe(2); }
  });

  it("selects deterministically under cardinality:nth", () => {
    const r = resolveTarget(searchButton({ cardinality: "nth", nth: 1 }),
      loadObservation("ambiguous-buttons"));
    expect(r.ok).toBe(true);
  });

  it("reports roleMismatch when the strategy matches the wrong role", () => {
    const t = searchButton({
      expectedRole: "link",
      primary: { kind: "roleAndName", params: { role: "button", name: "Search" } },
    });
    const r = resolveTarget(t, loadObservation("member-search"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("roleMismatch");
  });

  it("returns notFound with every attempt recorded when nothing matches", () => {
    const t = searchButton({
      primary: { kind: "roleAndName", params: { role: "button", name: "Nope" } },
      fallbacks: [{ kind: "roleAndName", params: { role: "button", name: "Also nope" } }],
    });
    const r = resolveTarget(t, loadObservation("member-search"));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.reason).toBe("notFound"); expect(r.attempts).toHaveLength(2); }
  });

  it("is deterministic — identical inputs give identical results", () => {
    const o = loadObservation("member-search"), t = searchButton();
    expect(JSON.stringify(resolveTarget(t, o))).toBe(JSON.stringify(resolveTarget(t, o)));
  });

  it("ignores invisible nodes", () => {
    const o = loadObservation("member-search");
    const hidden = { ...o, nodes: o.nodes.map((n) => ({ ...n, state: { ...n.state, visible: false } })) };
    expect(resolveTarget(searchButton(), hidden).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/unit/resolution/resolve-target.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/resolution/resolve-target.ts`**

```ts
import type { Observation, UiNode } from "../model/observation.js";
import type { Resolution, StrategyAttempt, TargetDescriptor, TargetStrategy } from "../model/target.js";
import { matchStrategy } from "./strategies.js";

export function resolveTarget(t: TargetDescriptor, o: Observation): Resolution {
  const attempts: StrategyAttempt[] = [];
  const ladder: TargetStrategy[] = [t.primary, ...t.fallbacks];

  for (let tier = 0; tier < ladder.length; tier++) {
    const strategy = ladder[tier]!;
    const raw = matchStrategy(strategy, t.scope, o).filter((n) => n.state.visible);

    if (raw.length === 0) {
      attempts.push({ strategy, tier, matchCount: 0, outcome: "noMatch" });
      continue;
    }

    const correctRole = raw.filter((n: UiNode) => n.role === t.expectedRole);
    if (correctRole.length === 0) {
      attempts.push({ strategy, tier, matchCount: raw.length, outcome: "roleMismatch" });
      continue;
    }

    if (t.cardinality === "nth") {
      const picked = correctRole[t.nth ?? 0];
      if (!picked) {
        attempts.push({ strategy, tier, matchCount: correctRole.length, outcome: "noMatch" });
        continue;
      }
      attempts.push({ strategy, tier, matchCount: correctRole.length, outcome: "matched" });
      return { ok: true, ref: picked.ref, tier, strategyUsed: strategy, attempts };
    }

    if (correctRole.length > 1) {
      attempts.push({ strategy, tier, matchCount: correctRole.length, outcome: "ambiguous" });
      continue;    // a later, narrower strategy may disambiguate
    }

    attempts.push({ strategy, tier, matchCount: 1, outcome: "matched" });
    return { ok: true, ref: correctRole[0]!.ref, tier, strategyUsed: strategy, attempts };
  }

  const last = attempts[attempts.length - 1];
  const reason =
    attempts.some((a) => a.outcome === "ambiguous") ? "ambiguous"
    : last?.outcome === "roleMismatch" ? "roleMismatch"
    : "notFound";
  return { ok: false, reason, matchCount: last?.matchCount ?? 0, attempts };
}
```

Note the deliberate choice: an ambiguous tier does **not** short-circuit — a narrower fallback gets its chance. Only if the whole ladder is exhausted does ambiguity become the verdict.

- [ ] **Step 4: Run and confirm it passes**

Run: `npx vitest run tests/unit/resolution/resolve-target.test.ts` — Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/resolution/resolve-target.ts tests/unit/resolution/resolve-target.test.ts
git commit -m "feat(resolution): deterministic fallback ladder with explicit ambiguity"
```

---

## Task 5: Condition evaluation, transforms, and value binding

**Files:**
- Create: `src/resolution/evaluate.ts`, `src/resolution/extract.ts`, `src/resolution/bind.ts`
- Test: `tests/unit/resolution/evaluate.test.ts`, `tests/unit/resolution/extract.test.ts`, `tests/unit/resolution/bind.test.ts`

**Interfaces:**
- Produces: `matchText(actual: string | undefined, m: TextMatcher): boolean`
- Produces: `evaluateCondition(c: Condition, o: Observation): ConditionResult`
- Produces: `readNode(n: UiNode, read: "text" | "value" | "name"): string | undefined`
- Produces: `applyTransforms(input: string, ts: readonly Transform[]): TransformResult` where
  `type TransformResult = { ok: true; value: string | number } | { ok: false; error: string }`
- Produces: `bindValue(v: ValueSource, ctx: BindContext): BindResult` where
  `interface BindContext { inputs: Record<string, string|number|boolean>; outputs: Record<string, unknown>; credentials: (ref: string) => string | undefined }`
  and `type BindResult = { ok: true; value: string } | { ok: false; error: string }`

- [ ] **Step 1: Write the failing tests**

`tests/unit/resolution/evaluate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { evaluateCondition, matchText } from "../../../src/resolution/evaluate.js";
import { loadObservation } from "../../fixtures/load.js";
import type { TargetDescriptor } from "../../../src/model/target.js";

const notice: TargetDescriptor = {
  scope: { path: [{ by: "name", value: "content" }],
           region: { by: "heading", value: "Search Results" } },
  expectedRole: "status",
  primary: { kind: "roleInRegion", params: { region: "Search Results", role: "status" } },
  fallbacks: [], cardinality: "exactlyOne", rationale: "Empty-result notice.",
};

describe("matchText", () => {
  it("is case-insensitive and whitespace-normalizing by default", () => {
    expect(matchText("  No   Matching Member ", { op: "contains", value: "no matching" })).toBe(true);
  });
  it("honours caseSensitive", () => {
    expect(matchText("Abc", { op: "equals", value: "abc", caseSensitive: true })).toBe(false);
  });
  it("supports startsWith and regex", () => {
    expect(matchText("Member: Dana", { op: "startsWith", value: "Member:" })).toBe(true);
    expect(matchText("$4,182.55", { op: "regex", value: "^\\$[0-9,]+\\.[0-9]{2}$" })).toBe(true);
  });
  it("returns false for undefined rather than throwing", () => {
    expect(matchText(undefined, { op: "contains", value: "x" })).toBe(false);
  });
});

describe("evaluateCondition", () => {
  it("text passes when the matcher matches", () => {
    const r = evaluateCondition(
      { kind: "text", target: notice, match: { op: "contains", value: "No matching member" } },
      loadObservation("not-found"));
    expect(r.passed).toBe(true);
  });

  it("text fails and reports what was observed", () => {
    const r = evaluateCondition(
      { kind: "text", target: notice, match: { op: "contains", value: "Account closed" } },
      loadObservation("not-found"));
    expect(r.passed).toBe(false);
    expect(r.observed).toContain("No matching member");
  });

  it("absent passes when the target does not resolve", () => {
    const r = evaluateCondition({ kind: "absent", target: notice }, loadObservation("member-detail"));
    expect(r.passed).toBe(true);
  });

  it("all requires every leaf; any requires one", () => {
    const o = loadObservation("not-found");
    const yes = { kind: "exists", target: notice } as const;
    const no = { kind: "text", target: notice, match: { op: "equals", value: "zzz" } } as const;
    expect(evaluateCondition({ kind: "all", of: [yes, no] }, o).passed).toBe(false);
    expect(evaluateCondition({ kind: "any", of: [yes, no] }, o).passed).toBe(true);
  });

  it("location matches against locationHint", () => {
    const r = evaluateCondition(
      { kind: "location", match: { op: "contains", value: "/teller/member/" } },
      loadObservation("member-detail"));
    expect(r.passed).toBe(true);
  });

  it("reports an unresolvable target as a failure, never a throw", () => {
    const bad: TargetDescriptor = { ...notice,
      primary: { kind: "roleAndName", params: { role: "button", name: "Nope" } } };
    const r = evaluateCondition({ kind: "exists", target: bad }, loadObservation("member-detail"));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("notFound");
  });
});
```

`tests/unit/resolution/extract.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyTransforms } from "../../../src/resolution/extract.js";

describe("applyTransforms", () => {
  it("converts USD currency text to a number", () => {
    expect(applyTransforms("$4,182.55", [{ kind: "currencyToNumber", currency: "USD" }]))
      .toEqual({ ok: true, value: 4182.55 });
  });
  it("applies the pipeline in order", () => {
    expect(applyTransforms("  Member: Dana Whitfield ",
      [{ kind: "trim" }, { kind: "stripPrefix", value: "Member: " }]))
      .toEqual({ ok: true, value: "Dana Whitfield" });
  });
  it("extracts a regex group", () => {
    expect(applyTransforms("*******4417", [{ kind: "extractGroup", pattern: "([0-9]{4})$", group: 1 }]))
      .toEqual({ ok: true, value: "4417" });
  });
  it("fails cleanly on unparseable currency instead of producing NaN", () => {
    const r = applyTransforms("n/a", [{ kind: "currencyToNumber", currency: "USD" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("currencyToNumber");
  });
  it("fails cleanly when a regex group is missing", () => {
    expect(applyTransforms("abc", [{ kind: "extractGroup", pattern: "([0-9]+)", group: 1 }]).ok)
      .toBe(false);
  });
  it("normalizes dates to ISO", () => {
    expect(applyTransforms("03/14/2026", [{ kind: "parseDate", format: "MM/DD/YYYY" }]))
      .toEqual({ ok: true, value: "2026-03-14" });
  });
});
```

`tests/unit/resolution/bind.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { bindValue } from "../../../src/resolution/bind.js";

const ctx = {
  inputs: { memberId: "100234" },
  outputs: { memberName: "Dana Whitfield" },
  credentials: (ref: string) => (ref === "corebank.teller.password" ? "s3cret" : undefined),
};

describe("bindValue", () => {
  it("binds an input", () => expect(bindValue({ from: "input", name: "memberId" }, ctx))
    .toEqual({ ok: true, value: "100234" }));
  it("binds a literal", () => expect(bindValue({ from: "literal", value: "Savings" }, ctx))
    .toEqual({ ok: true, value: "Savings" }));
  it("binds an earlier output", () => expect(bindValue({ from: "output", name: "memberName" }, ctx))
    .toEqual({ ok: true, value: "Dana Whitfield" }));
  it("binds a credential from the runtime resolver", () =>
    expect(bindValue({ from: "credential", ref: "corebank.teller.password" }, ctx))
      .toEqual({ ok: true, value: "s3cret" }));
  it("fails when an input is missing, naming it", () => {
    const r = bindValue({ from: "input", name: "nope" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("nope");
  });
  it("fails when a credential is not configured", () =>
    expect(bindValue({ from: "credential", ref: "absent" }, ctx).ok).toBe(false));
});
```

- [ ] **Step 2: Run all three and confirm they fail**

Run: `npx vitest run tests/unit/resolution/` — Expected: 3 files fail to resolve imports.

- [ ] **Step 3: Implement `src/resolution/evaluate.ts`**

```ts
import type { Condition, ConditionResult, LeafCondition, TextMatcher } from "../model/condition.js";
import type { Observation, UiNode } from "../model/observation.js";
import { resolveTarget } from "./resolve-target.js";
import { normalizeText } from "./strategies.js";

export function matchText(actual: string | undefined, m: TextMatcher): boolean {
  if (actual === undefined) return false;
  const norm = (s: string) => {
    const w = m.normalizeWhitespace === false ? s : normalizeText(s);
    return m.caseSensitive ? w : w.toLowerCase();
  };
  const a = norm(actual), b = norm(m.value);
  switch (m.op) {
    case "equals":     return a === b;
    case "contains":   return a.includes(b);
    case "startsWith": return a.startsWith(b);
    case "regex":      return new RegExp(m.value, m.caseSensitive ? "" : "i").test(actual);
  }
}

const nodeText = (n: UiNode): string | undefined => n.value ?? n.name;

function evaluateLeaf(c: LeafCondition, o: Observation): ConditionResult {
  if (c.kind === "location") {
    const passed = matchText(o.locationHint, c.match);
    return { passed, observed: o.locationHint ?? "", detail: `location ${c.match.op} "${c.match.value}"` };
  }

  const r = resolveTarget(c.target, o);
  if (!r.ok) {
    const passed = c.kind === "absent";
    return { passed, detail: `target ${r.reason} (${r.attempts.length} strategies tried)` };
  }
  const node = o.nodes.find((n) => n.ref === r.ref)!;

  switch (c.kind) {
    case "exists": return { passed: true,  detail: `resolved at tier ${r.tier}` };
    case "absent": return { passed: false, observed: nodeText(node), detail: "target unexpectedly present" };
    case "text": {
      const actual = nodeText(node);
      return { passed: matchText(actual, c.match), observed: actual,
               detail: `text ${c.match.op} "${c.match.value}"` };
    }
    case "value":
      return { passed: matchText(node.value, c.match), observed: node.value,
               detail: `value ${c.match.op} "${c.match.value}"` };
  }
}

export function evaluateCondition(c: Condition, o: Observation): ConditionResult {
  if (c.kind === "all" || c.kind === "any") {
    const results = c.of.map((leaf) => evaluateLeaf(leaf, o));
    const passed = c.kind === "all" ? results.every((r) => r.passed) : results.some((r) => r.passed);
    const blame = results.find((r) => r.passed !== passed) ?? results[0];
    return { passed, observed: blame?.observed,
             detail: `${c.kind}: ${results.map((r) => `${r.passed ? "ok" : "FAIL"} ${r.detail}`).join("; ")}` };
  }
  return evaluateLeaf(c, o);
}
```

- [ ] **Step 4: Implement `src/resolution/extract.ts`**

```ts
import type { Transform } from "../model/transform.js";
import type { UiNode } from "../model/observation.js";
import { normalizeText } from "./strategies.js";

export type TransformResult = { ok: true; value: string | number } | { ok: false; error: string };

export function readNode(n: UiNode, read: "text" | "value" | "name"): string | undefined {
  return read === "value" ? n.value : read === "name" ? n.name : (n.value ?? n.name);
}

export function applyTransforms(input: string, ts: readonly Transform[]): TransformResult {
  let cur: string | number = input;
  for (const t of ts) {
    if (typeof cur === "number" && t.kind !== "toNumber") {
      return { ok: false, error: `${t.kind}: input is already a number` };
    }
    const s = String(cur);
    switch (t.kind) {
      case "trim":                cur = s.trim(); break;
      case "normalizeWhitespace": cur = normalizeText(s); break;
      case "stripPrefix":         cur = s.startsWith(t.value) ? s.slice(t.value.length) : s; break;
      case "stripSuffix":         cur = s.endsWith(t.value) ? s.slice(0, -t.value.length) : s; break;
      case "extractGroup": {
        const m = new RegExp(t.pattern).exec(s);
        const g = m?.[t.group];
        if (g === undefined) return { ok: false, error: `extractGroup: no group ${t.group} in "${s}"` };
        cur = g; break;
      }
      case "currencyToNumber": {
        const n = Number(s.replace(/[$,\s]/g, ""));
        if (!Number.isFinite(n)) return { ok: false, error: `currencyToNumber: cannot parse "${s}"` };
        cur = n; break;
      }
      case "toNumber": {
        const n = Number(String(cur).replace(/[,\s]/g, ""));
        if (!Number.isFinite(n)) return { ok: false, error: `toNumber: cannot parse "${cur}"` };
        cur = n; break;
      }
      case "parseDate": {
        const m = t.format === "MM/DD/YYYY"
          ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim())
          : /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
        if (!m) return { ok: false, error: `parseDate: "${s}" is not ${t.format}` };
        cur = t.format === "MM/DD/YYYY" ? `${m[3]}-${m[1]}-${m[2]}` : `${m[1]}-${m[2]}-${m[3]}`;
        break;
      }
    }
  }
  return { ok: true, value: cur };
}
```

- [ ] **Step 5: Implement `src/resolution/bind.ts`**

```ts
import type { ValueSource } from "../model/action.js";

export interface BindContext {
  readonly inputs: Readonly<Record<string, string | number | boolean>>;
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly credentials: (ref: string) => string | undefined;
}
export type BindResult = { ok: true; value: string } | { ok: false; error: string };

export function bindValue(v: ValueSource, ctx: BindContext): BindResult {
  switch (v.from) {
    case "literal": return { ok: true, value: v.value };
    case "input": {
      const x = ctx.inputs[v.name];
      return x === undefined ? { ok: false, error: `no value for input "${v.name}"` }
                             : { ok: true, value: String(x) };
    }
    case "output": {
      const x = ctx.outputs[v.name];
      return x === undefined ? { ok: false, error: `output "${v.name}" not yet extracted` }
                             : { ok: true, value: String(x) };
    }
    case "credential": {
      const x = ctx.credentials(v.ref);
      return x === undefined ? { ok: false, error: `credential "${v.ref}" is not configured` }
                             : { ok: true, value: x };
    }
  }
}
```

- [ ] **Step 6: Run and confirm they pass**

Run: `npx vitest run tests/unit/resolution/` — Expected: 26 passed.

- [ ] **Step 7: Commit**

```bash
git add src/resolution tests/unit/resolution
git commit -m "feat(resolution): condition evaluation, typed transforms, and value binding"
```

---

## Task 6: The capability schema

**Files:**
- Create: `src/model/outcome.ts`, `src/model/capability.ts`
- Test: `tests/unit/model/capability.test.ts`

**Interfaces:**
- Produces: Zod schemas `Capability`, `AppProfile`, `InputSpec`, `OutputSpec`, `Step`, `OutcomeDefinition`, `Recovery`, plus inferred types `type Capability = z.infer<typeof CapabilitySchema>` etc.
- Produces: `parseCapability(json: unknown): Capability` — throws a `CapabilityValidationError` listing every issue.

Implement exactly the schema in spec §5, including `assertReplayable`. Naming: export the Zod object as `CapabilitySchema` and the inferred type as `Capability`.

- [ ] **Step 1: Write the failing test**

`tests/unit/model/capability.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseCapability } from "../../../src/model/capability.js";

const valid = () => JSON.parse(readFileSync(
  "capabilities/corebank.member.readSavingsBalance/1.0.0.json", "utf8"));

describe("parseCapability", () => {
  it("accepts the reference artifact", () => {
    expect(() => parseCapability(valid())).not.toThrow();
  });

  it("rejects an absolute URL in the entry path", () => {
    const c = valid(); c.app.entry.path = "https://bank.example.com/teller/search";
    expect(() => parseCapability(c)).toThrow(/path/);
  });

  it("rejects a ValueSource naming an undeclared input", () => {
    const c = valid(); c.steps[0].action.value = { from: "input", name: "ghost" };
    expect(() => parseCapability(c)).toThrow(/ghost/);
  });

  it("rejects an OutputSpec sourced from a nonexistent step", () => {
    const c = valid(); c.outputs.savingsBalance.source.from = "s99";
    expect(() => parseCapability(c)).toThrow(/s99/);
  });

  it("rejects a recoverable outcome with no recovery", () => {
    const c = valid();
    c.outcomes.push({ code: "FLAKY", class: "recoverable", scope: "anyStep",
      description: "no recovery declared here", detect: c.outcomes[0].detect });
    expect(() => parseCapability(c)).toThrow(/recovery/);
  });

  it("rejects a business outcome that tries to escalate", () => {
    const c = valid(); c.outcomes[0].escalate = true;
    expect(() => parseCapability(c)).toThrow(/business/);
  });

  it("rejects duplicate outcome codes", () => {
    const c = valid(); c.outcomes.push({ ...c.outcomes[0] });
    expect(() => parseCapability(c)).toThrow(/MEMBER_NOT_FOUND/);
  });

  it("rejects a literal bound to a sensitive input", () => {
    const c = valid();
    c.inputs.memberId.sensitivity = "pii";
    c.steps[0].action.value = { from: "literal", value: "100234" };
    expect(() => parseCapability(c)).toThrow(/sensitiv/i);
  });

  it("rejects a recovery containing more than five actions", () => {
    const c = valid();
    c.outcomes.push({ code: "LONG_RECOVERY", class: "recoverable", scope: "anyStep",
      description: "too many recovery actions to be bounded",
      detect: c.outcomes[0].detect,
      recovery: { actions: Array(6).fill(c.steps[1].action), resume: "retryStep", maxAttempts: 1 } });
    expect(() => parseCapability(c)).toThrow();
  });

  it("rejects a step with neither a checkpoint nor an explicit null", () => {
    const c = valid(); delete c.steps[0].checkpoint;
    expect(() => parseCapability(c)).toThrow(/checkpoint/);
  });
});
```

- [ ] **Step 2: Write `capabilities/corebank.member.readSavingsBalance/1.0.0.json`**

Copy the complete reference artifact from spec §5 verbatim, with two adjustments already decided: `$ref` pointers are expanded inline, and step `s4` uses `{ "kind": "wait", "for": …, "timeoutMs": 10000, "pollMs": 250 }` instead of a `pressKey:"None"` no-op. Also write `profiles/corebank-teller@8.json` from the spec, with its three inherited outcomes fully expanded (no elided descriptors).

- [ ] **Step 3: Run and confirm failure**

Run: `npx vitest run tests/unit/model/capability.test.ts` — Expected: FAIL, `parseCapability` not found.

- [ ] **Step 4: Implement `src/model/outcome.ts` then `src/model/capability.ts`**

Write the Zod schema exactly as spec §5 specifies. Then `assertReplayable` as a `superRefine` on the capability object:

```ts
function assertReplayable(c: CapabilityShape, ctx: z.RefinementCtx): void {
  const stepIds = new Set(c.steps.map((s) => s.id));
  const inputNames = new Set(Object.keys(c.inputs));
  const outputNames = new Set(Object.keys(c.outputs));
  const issue = (message: string, path: (string | number)[]) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

  const checkValue = (v: ValueSource, where: (string | number)[], inputName?: string) => {
    if (v.from === "input" && !inputNames.has(v.name))
      issue(`step references undeclared input "${v.name}"`, where);
    if (v.from === "output" && !outputNames.has(v.name))
      issue(`step references undeclared output "${v.name}"`, where);
    if (v.from === "literal" && inputName && c.inputs[inputName]?.sensitivity !== "none")
      issue(`literal value bound to sensitive input "${inputName}" — use {from:"input"}`, where);
  };

  c.steps.forEach((s, i) => {
    if (!("checkpoint" in s))
      issue(`step ${s.id} must declare a checkpoint, or checkpoint:null with a reason`, ["steps", i]);
    if ("value" in s.action) checkValue(s.action.value, ["steps", i, "action", "value"]);
  });

  Object.entries(c.outputs).forEach(([name, o]) => {
    if (!stepIds.has(o.source.from))
      issue(`output "${name}" reads from unknown step "${o.source.from}"`, ["outputs", name]);
  });

  const seen = new Set<string>();
  c.outcomes.forEach((o, i) => {
    if (seen.has(o.code)) issue(`duplicate outcome code "${o.code}"`, ["outcomes", i]);
    seen.add(o.code);
    if (typeof o.scope === "object")
      for (const id of o.scope.steps)
        if (!stepIds.has(id)) issue(`outcome "${o.code}" scopes unknown step "${id}"`, ["outcomes", i]);
    for (const a of o.recovery?.actions ?? [])
      if (classifyAction(a) === "irreversible")
        issue(`outcome "${o.code}" recovery contains an irreversible action`, ["outcomes", i]);
  });
}
```

`classifyAction` lives in `src/policy/risk.ts` (Task 7); to keep `model/` dependency-free, inline a
minimal local copy here — a `click` on a target whose `expectedRole` is `button` and whose rationale
or strategy name matches `/submit|confirm|post|transfer|delete/i` is `irreversible`, `fill`/`select`
are `reversible`, everything else `readOnly`. Task 7's `classifyAction` must return the same verdict
for the same action; a test in Task 7 asserts they agree.

- [ ] **Step 5: Run and confirm it passes**

Run: `npx vitest run tests/unit/model/capability.test.ts` — Expected: 10 passed.

- [ ] **Step 6: Commit**

```bash
git add src/model/capability.ts src/model/outcome.ts capabilities profiles tests/unit/model
git commit -m "feat(model): capability schema with replayability assertions"
```

---

## Task 7: Policy engine — allowlist, risk, redaction

**Files:**
- Create: `src/policy/policy.config.ts`, `src/policy/risk.ts`, `src/policy/redaction.ts`, `src/policy/policy-engine.ts`
- Test: `tests/unit/policy/policy-engine.test.ts`, `tests/unit/policy/redaction.test.ts`

**Interfaces:**
- Produces: `classifyAction(a: StepAction): RiskClass`
- Produces: `redactValue(v: string, s: Sensitivity): string`, `redactObservation(o: Observation): Observation`, `redactText(s: string): string`
- Produces: `class PolicyEngine { constructor(cfg: PolicyConfig); checkNavigation(url: string): PolicyVerdict; checkAction(a: StepAction, ctx: PolicyContext): PolicyVerdict; classify(a: StepAction): RiskClass; redactObservation(o: Observation): Observation }`

- [ ] **Step 1: Write the failing tests**

`tests/unit/policy/policy-engine.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PolicyEngine } from "../../../src/policy/policy-engine.js";
import type { StepAction } from "../../../src/model/action.js";

const cfg = {
  allowedOrigins: ["http://localhost:4000"],
  allowedPathPrefixes: ["/teller"],
  allowedActionKinds: ["click", "fill", "select", "pressKey", "wait", "navigate", "dismiss"] as const,
};
const engine = new PolicyEngine(cfg);
const target = { scope: { path: [{ by: "name", value: "content" }] }, expectedRole: "button",
  primary: { kind: "roleAndName", params: { role: "button", name: "Search" } },
  fallbacks: [], cardinality: "exactlyOne", rationale: "search submit" } as const;
const click: StepAction = { kind: "click", target };
const ctx = { mode: "replay", approval: "approved", unattended: true } as const;

describe("checkNavigation", () => {
  it("allows an allowlisted origin and path", () =>
    expect(engine.checkNavigation("http://localhost:4000/teller/search").allow).toBe("yes"));
  it("denies a different origin", () => {
    const v = engine.checkNavigation("http://evil.example.com/teller/search");
    expect(v.allow).toBe("no");
    if (v.allow === "no") expect(v.code).toBe("ORIGIN_NOT_ALLOWED");
  });
  it("denies a path outside the allowed prefixes", () =>
    expect(engine.checkNavigation("http://localhost:4000/admin/wipe").allow).toBe("no"));
});

describe("checkAction", () => {
  it("allows a read-only action", () => expect(engine.checkAction(click, ctx).allow).toBe("yes"));

  it("denies an action kind that is not allowlisted", () => {
    const narrow = new PolicyEngine({ ...cfg, allowedActionKinds: ["wait"] });
    expect(narrow.checkAction(click, ctx).allow).toBe("no");
  });

  it("requires confirmation for an irreversible action run unattended", () => {
    const post: StepAction = { kind: "click",
      target: { ...target, rationale: "Submit the transfer and post it to the core" } };
    expect(engine.checkAction(post, ctx).allow).toBe("withConfirmation");
  });

  it("requires confirmation for a draft capability even when read-only", () => {
    expect(engine.checkAction(click, { ...ctx, approval: "draft" }).allow).toBe("withConfirmation");
  });
});

describe("classify agrees with the model-layer copy", () => {
  it("classifies fill as reversible and a submit click as irreversible", () => {
    expect(engine.classify({ kind: "fill", target, value: { from: "literal", value: "x" } }))
      .toBe("reversible");
    expect(engine.classify({ kind: "click",
      target: { ...target, rationale: "Confirm and post the transfer" } })).toBe("irreversible");
  });
});
```

`tests/unit/policy/redaction.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { redactValue, redactText, redactObservation } from "../../../src/policy/redaction.js";
import { loadObservation } from "../../fixtures/load.js";

describe("redactValue", () => {
  it("fully masks a secret", () => expect(redactValue("s3cret", "secret")).toBe("[REDACTED]"));
  it("keeps the last 4 of an identifier", () => expect(redactValue("100234", "identifier")).toBe("**0234"));
  it("masks pii entirely", () => expect(redactValue("Dana Whitfield", "pii")).toBe("[REDACTED]"));
  it("keeps the magnitude but not the figure for financial", () =>
    expect(redactValue("$4,182.55", "financial")).toBe("[FINANCIAL]"));
  it("passes through non-sensitive values", () => expect(redactValue("Search", "none")).toBe("Search"));
});

describe("redactText", () => {
  it("masks anything shaped like an SSN", () =>
    expect(redactText("ssn 123-45-6789 on file")).toBe("ssn [REDACTED-SSN] on file"));
  it("masks long digit runs that look like account numbers", () =>
    expect(redactText("acct 4417889900123")).toContain("[REDACTED-ACCT]"));
});

describe("redactObservation", () => {
  it("masks node values that look sensitive but preserves structure", () => {
    const o = redactObservation(loadObservation("member-detail"));
    expect(o.nodes).toHaveLength(loadObservation("member-detail").nodes.length);
    expect(o.nodes.map((n) => n.role)).toContain("cell");
    expect(JSON.stringify(o)).not.toContain("4417");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/unit/policy/` — Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `src/policy/policy.config.ts` and `risk.ts`**

```ts
// policy.config.ts
import type { ActionKind } from "../model/action.js";
export interface PolicyConfig {
  readonly allowedOrigins: readonly string[];
  readonly allowedPathPrefixes: readonly string[];
  readonly allowedActionKinds: readonly ActionKind[];
}
export const defaultPolicy: PolicyConfig = {
  allowedOrigins: [process.env["TARGET_BASE_URL"] ?? "http://localhost:4000"],
  allowedPathPrefixes: ["/teller"],
  allowedActionKinds: ["click", "fill", "select", "pressKey", "wait", "navigate", "dismiss"],
};
```

```ts
// risk.ts
import type { StepAction } from "../model/action.js";
export type RiskClass = "readOnly" | "reversible" | "irreversible";

const MUTATING = /\b(submit|confirm|post|transfer|delete|remove|approve|close|open account|authorize)\b/i;

export function classifyAction(a: StepAction): RiskClass {
  switch (a.kind) {
    case "wait": case "pressKey": case "navigate": case "dismiss": return "readOnly";
    case "fill": case "select": return "reversible";
    case "click": {
      const hay = `${a.target.rationale} ${JSON.stringify(a.target.primary.params)}`;
      return MUTATING.test(hay) ? "irreversible" : "readOnly";
    }
  }
}
```

Rationale for the heuristic, to state in REPORT.md: a click is the only action whose reversibility
cannot be read off its kind, so the artifact's own recorded intent is used as the signal, and the
result is stored in the artifact for a human to confirm during review. It errs toward flagging.

- [ ] **Step 4: Implement `src/policy/redaction.ts`**

```ts
import type { Observation, UiNode } from "../model/observation.js";
export type Sensitivity = "none" | "identifier" | "pii" | "financial" | "secret";

const SSN   = /\b\d{3}-\d{2}-\d{4}\b/g;
const ACCT  = /\b\d{9,}\b/g;
const MONEY = /\$[\d,]+\.\d{2}/g;

export function redactValue(v: string, s: Sensitivity): string {
  switch (s) {
    case "none":       return v;
    case "identifier": return v.length <= 4 ? "[REDACTED]" : "*".repeat(v.length - 4) + v.slice(-4);
    case "pii":
    case "secret":     return "[REDACTED]";
    case "financial":  return "[FINANCIAL]";
  }
}

export function redactText(s: string): string {
  return s.replace(SSN, "[REDACTED-SSN]").replace(ACCT, "[REDACTED-ACCT]").replace(MONEY, "[FINANCIAL]");
}

export function redactObservation(o: Observation): Observation {
  const scrub = (n: UiNode): UiNode => ({
    ...n,
    name:  n.name  === undefined ? undefined : redactText(n.name),
    value: n.value === undefined ? undefined : redactText(n.value),
    anchors: n.anchors.map((a) => ({ ...a, text: redactText(a.text) })),
  });
  return { ...o, nodes: o.nodes.map(scrub) };
}
```

Structure survives redaction — roles, scopes and anchors are intact, so the model can still reason
and a reviewer can still debug, but figures and identifiers do not leave the process.

Note the deliberate limitation for REPORT.md: this is pattern-based redaction on a known surface,
not general PII detection. It is a guardrail, not a guarantee.

- [ ] **Step 5: Implement `src/policy/policy-engine.ts`**

```ts
import type { StepAction } from "../model/action.js";
import type { Observation } from "../model/observation.js";
import { classifyAction, type RiskClass } from "./risk.js";
import { redactObservation } from "./redaction.js";
import type { PolicyConfig } from "./policy.config.js";

export type PolicyDenialCode =
  | "ORIGIN_NOT_ALLOWED" | "PATH_NOT_ALLOWED" | "ACTION_KIND_NOT_ALLOWED";

export type PolicyVerdict =
  | { readonly allow: "yes" }
  | { readonly allow: "no"; readonly code: PolicyDenialCode; readonly reason: string }
  | { readonly allow: "withConfirmation"; readonly reason: string };

export interface PolicyContext {
  readonly mode: "discovery" | "replay";
  readonly approval?: "draft" | "in_review" | "approved" | "deprecated";
  readonly unattended: boolean;
}

export class PolicyEngine {
  constructor(private readonly cfg: PolicyConfig) {}

  checkNavigation(url: string): PolicyVerdict {
    let u: URL;
    try { u = new URL(url); }
    catch { return { allow: "no", code: "ORIGIN_NOT_ALLOWED", reason: `unparseable URL: ${url}` }; }
    if (!this.cfg.allowedOrigins.includes(u.origin))
      return { allow: "no", code: "ORIGIN_NOT_ALLOWED", reason: `origin ${u.origin} is not allowlisted` };
    if (!this.cfg.allowedPathPrefixes.some((p) => u.pathname.startsWith(p)))
      return { allow: "no", code: "PATH_NOT_ALLOWED", reason: `path ${u.pathname} is not allowlisted` };
    return { allow: "yes" };
  }

  classify(a: StepAction): RiskClass { return classifyAction(a); }

  checkAction(a: StepAction, ctx: PolicyContext): PolicyVerdict {
    if (!this.cfg.allowedActionKinds.includes(a.kind))
      return { allow: "no", code: "ACTION_KIND_NOT_ALLOWED", reason: `action kind "${a.kind}" is not permitted` };

    const risk = this.classify(a);
    if (risk === "irreversible" && ctx.unattended)
      return { allow: "withConfirmation", reason: "irreversible action attempted unattended" };
    if (ctx.mode === "replay" && ctx.approval !== "approved")
      return { allow: "withConfirmation", reason: `capability status is "${ctx.approval}", not approved` };
    return { allow: "yes" };
  }

  redactObservation(o: Observation): Observation { return redactObservation(o); }
}
```

- [ ] **Step 6: Run and confirm they pass**

Run: `npx vitest run tests/unit/policy/` — Expected: 17 passed.

- [ ] **Step 7: Commit**

```bash
git add src/policy tests/unit/policy
git commit -m "feat(policy): allowlist, risk classification, and redaction as one choke point"
```

---

## Task 8: The hostile target application

**Files:**
- Create: `apps/target-app/server.ts`, `apps/target-app/state.ts`, `apps/target-app/faults.ts`, `apps/target-app/views/*.html`
- Test: `tests/integration/target-app.test.ts`

**Interfaces:**
- Produces: an Express app on `TARGET_APP_PORT` (default 4000) exporting `createTargetApp(): express.Express` so tests can start it on an ephemeral port.
- Produces: `POST /_control/faults` with body `{ fault: FaultName | null }`, `POST /_control/reset`.
  `type FaultName = "notFound" | "validationError" | "interstitial" | "sessionExpired" | "permissionDenied" | "slowLoad" | "appError"`.

Deliberately hostile, and capped: framesets, table layout, no test IDs, `<label for>` present, server-rendered POSTs, incidental structure that shifts between renders.

- [ ] **Step 1: Write the failing test**

`tests/integration/target-app.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createTargetApp } from "../../apps/target-app/server.js";

let server: Server; let base: string;

beforeAll(async () => {
  server = createTargetApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise((r) => server.close(() => r(undefined))));

const post = (p: string, body: unknown) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify(body) });
const form = (p: string, data: Record<string, string>) =>
  fetch(base + p, { method: "POST", redirect: "follow",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data).toString() });

describe("target app", () => {
  it("serves a frameset shell at /teller", async () => {
    const html = await (await fetch(`${base}/teller`)).text();
    expect(html).toContain("<frameset");
    expect(html).toContain('name="content"');
  });

  it("has a labelled Member ID field and no test ids", async () => {
    const html = await (await fetch(`${base}/teller/search`)).text();
    expect(html).toMatch(/<label\s+for="[^"]+"\s*>\s*Member ID/);
    expect(html).not.toContain("data-testid");
  });

  it("finds a known member and shows the accounts table", async () => {
    const html = await (await form("/teller/search", { memberId: "100234" })).text();
    expect(html).toContain("Dana Whitfield");
    expect(html).toContain("Current Balance");
    expect(html).toContain("$4,182.55");
  });

  it("returns a not-found notice for an unknown member", async () => {
    const html = await (await form("/teller/search", { memberId: "999999" })).text();
    expect(html).toContain("No matching member");
  });

  it("returns a validation error for a malformed member id", async () => {
    const html = await (await form("/teller/search", { memberId: "12" })).text();
    expect(html).toContain("must be 6 digits");
  });

  it("shows the login form once the sessionExpired fault is armed", async () => {
    await post("/_control/faults", { fault: "sessionExpired" });
    const html = await (await fetch(`${base}/teller/search`)).text();
    expect(html).toContain("Sign On");
    await post("/_control/reset", {});
  });

  it("shows an interstitial that can be acknowledged, then proceeds", async () => {
    await post("/_control/faults", { fault: "interstitial" });
    const first = await (await fetch(`${base}/teller/search`)).text();
    expect(first).toContain("Acknowledge");
    await form("/teller/acknowledge", {});
    expect(await (await fetch(`${base}/teller/search`)).text()).toContain("Member ID");
    await post("/_control/reset", {});
  });

  it("denies permission when that fault is armed", async () => {
    await post("/_control/faults", { fault: "permissionDenied" });
    expect(await (await form("/teller/search", { memberId: "100234" })).text())
      .toContain("not authorized");
    await post("/_control/reset", {});
  });

  it("shifts incidental DOM structure between renders but keeps labels stable", async () => {
    const a = await (await fetch(`${base}/teller/search`)).text();
    const b = await (await fetch(`${base}/teller/search`)).text();
    expect(a).not.toBe(b);                                    // incidental wrappers differ
    expect(b).toMatch(/<label\s+for="[^"]+"\s*>\s*Member ID/); // the semantic anchor does not
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/integration/target-app.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `apps/target-app/state.ts`**

```ts
export interface Account { type: string; number: string; balance: string; }
export interface Member { id: string; name: string; accounts: Account[]; }

export const MEMBERS: Record<string, Member> = {
  "100234": { id: "100234", name: "Dana Whitfield", accounts: [
    { type: "Savings",  number: "*******4417", balance: "$4,182.55" },
    { type: "Checking", number: "*******9021", balance: "$912.10" }] },
  "100999": { id: "100999", name: "Ray Okonkwo", accounts: [
    { type: "Savings",  number: "*******7788", balance: "$210.00" }] },
};
```

All data is synthetic. No real names, no real account numbers — stated in the README.

- [ ] **Step 4: Implement `apps/target-app/faults.ts` and `server.ts`**

`faults.ts` holds a module-level `armed: FaultName | null` plus `arm()`, `reset()`, `consume()`
(one-shot faults like `interstitial` clear once acknowledged). `server.ts` renders HTML by string
templates with:

- `/teller` → `<frameset cols="180,*">` with `nav` and `content` frames.
- `/teller/search` → a `<table>`-laid-out form, `<label for="mid">Member ID</label>` +
  `<input id="mid" name="memberId">`, submit `<input type="submit" value="Search">`.
  Wrap the form in `n` nested `<div>`s where `n` alternates per render — incidental structure
  that shifts, so a positional selector breaks and a semantic one does not.
- `POST /teller/search` → validation (`^\d{6}$` else the validation error), lookup (else the
  not-found notice), otherwise `302` to `/teller/member/:id`.
- `/teller/member/:id` → member detail: an `<h2>Member Detail</h2>` region with
  `<h3>Member: Name</h3>`, then an `<h2>Accounts</h2>` region with a `<table>` whose header row is
  `Account Type | Account | Current Balance`.
- `slowLoad` delays the response by 3s; `appError` returns a 500 page reading
  "Unexpected system error"; `sessionExpired` renders the login form for any `/teller/*` GET;
  `interstitial` renders an acknowledge modal ahead of the requested page; `permissionDenied`
  renders "You are not authorized to view this member."
- `POST /_control/faults`, `POST /_control/reset`.

- [ ] **Step 5: Run and confirm it passes**

Run: `npx vitest run tests/integration/target-app.test.ts` — Expected: 9 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/target-app tests/integration/target-app.test.ts
git commit -m "feat(target-app): hostile CoreBank Teller with injectable runtime faults"
```

---

## Task 9: Playwright surface — perception and execution

**Files:**
- Create: `src/surface/surface.ts`, `src/surface/web/perceive.ts`, `src/surface/web/playwright-surface.ts`, `src/surface/desktop/README.md`
- Test: `tests/integration/surface.test.ts`

**Interfaces:**
- Produces: `interface Surface { readonly kind; observe(): Promise<Observation>; execute(a: ResolvedAction): Promise<void>; capture(reason: string): Promise<EvidenceRef>; instrument(on: boolean): Promise<void>; dispose(): Promise<void> }`
- Produces: `class PlaywrightWebSurface implements Surface` with
  `static async launch(opts: { baseUrl: string; headless: boolean; lease: ControlLease; evidenceDir: string }): Promise<PlaywrightWebSurface>`
- Produces: `resolveRefToHandle` is **private**. Refs are minted per observation and invalidated on the next `observe()`; executing against a stale ref throws `StaleRefError`.

`src/surface/` must not import `src/resolution/`.

- [ ] **Step 1: Write the failing test**

`tests/integration/surface.test.ts` — starts the target app, launches the surface headless, and asserts:

```ts
it("observes labelled controls inside the content frame", async () => {
  const o = await surface.observe();
  const mid = o.nodes.find((n) => n.anchors.some((a) => a.kind === "label" && a.text === "Member ID"));
  expect(mid?.role).toBe("textbox");
  expect(mid?.scope.path).toEqual([{ by: "name", value: "content" }]);
});

it("exposes table cells with row and column anchors", async () => { /* fill+click to detail, then */
  const cell = o.nodes.find((n) => n.role === "cell"
    && n.anchors.some((a) => a.kind === "rowHeader" && a.text === "Savings")
    && n.anchors.some((a) => a.kind === "columnHeader" && a.text === "Current Balance"));
  expect(cell?.value).toBe("$4,182.55");
});

it("assigns a region from the nearest preceding heading", async () => {
  expect(cell?.scope.region).toEqual({ by: "heading", value: "Accounts" });
});

it("executes fill and click against refs", async () => { /* ... */ });

it("rejects a stale ref from a previous observation", async () => {
  const first = await surface.observe();
  await surface.execute({ kind: "navigate", url: `${base}/teller/search` });
  await surface.observe();
  await expect(surface.execute({ kind: "click", ref: first.nodes[0]!.ref })).rejects.toThrow(/stale/i);
});

it("refuses to execute when the operator holds the lease", async () => {
  await lease.transfer("automation", "operator", "test");
  await expect(surface.execute({ kind: "click", ref })).rejects.toThrow(/ControlNotHeld/);
  await lease.transfer("operator", "automation", "test");
});

it("produces a stable screenSignature for the same screen and a different one across screens",
   async () => { /* ... */ });

it("captures a screenshot to the evidence directory", async () => {
  const ref = await surface.capture("test");
  expect(existsSync(ref.path)).toBe(true);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/integration/surface.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/surface/web/perceive.ts`**

A single `page.evaluate` per frame walking the DOM and emitting `RawNode[]`:

- **role**: from an explicit `role` attribute, else mapped from the tag (`input[type=text]`→`textbox`,
  `input[type=submit]`/`button`→`button`, `a[href]`→`link`, `td`/`th`→`cell`, `table`→`table`,
  `h1`-`h6`→`heading`, `select`→`combobox`, `[role=alert]`/`.error`→`alert`, `.notice`→`status`).
- **name**: `aria-label`, else associated `<label for>` text, else the element's own trimmed text,
  else `value` for submit inputs, else `title`.
- **value**: `input.value` for controls; `textContent` for cells and static nodes.
- **anchors**: `label` from `<label for>`; for a `td`, `rowHeader` = first cell's text in the same
  `<tr>`, `columnHeader` = the `<th>` (or first row's cell) at the same column index;
  `sectionHeading` = nearest preceding `h1`-`h6`; `precedingText` = previous sibling's text, trimmed.
- **scope.region**: nearest preceding heading text (this is what makes `roleInRegion` work on a
  surface with no landmarks).
- **state.visible**: `offsetParent !== null || position === "fixed"`.
- **attrs**: allowlisted only — `inputType`, `tagName`. Never a selector.

Node-side, iterate `page.frames()`, derive each frame's `ScopeSegment` (`name` when the frame has one,
else `urlPath`, else `index`), mint `ref` as `f{frameIndex}n{nodeIndex}`, and compute
`screenSignature` as a hash of the ordered `role|scopeKey` list — structure only, no values, so the
signature is stable across different members and changes when the screen changes.

- [ ] **Step 4: Implement `playwright-surface.ts`**

Keeps `#handles: Map<Ref, {frame, backendId}>` valid only for the latest observation, plus
`#observationId`. `execute()` calls `lease.assertHeldBy("automation")` first, then rejects refs
whose observation id is not current with `StaleRefError`. `capture()` writes
`<evidenceDir>/screenshots/<ts>-<reason>.png` and returns `{ kind: "screenshot", path }`.

- [ ] **Step 5: Write `src/surface/desktop/README.md`**

Document the seam concretely: what a `DesktopSurface` would implement, how UIA `ControlType` and AX
`AXRole` map onto the normalized role vocabulary, how `ScopeSegment.by:"title"` addresses a window,
what `anchoredCell` means in a UIA grid pattern, and which parts of `perceive.ts` have no desktop
analogue (`urlPath` scoping, `location` conditions). State plainly that the accessibility APIs are
different from the web's and that the adaptation is real work — the claim is a common normalized
representation, not equivalent APIs.

- [ ] **Step 6: Run and confirm it passes**

Run: `npx vitest run tests/integration/surface.test.ts` — Expected: 8 passed.

- [ ] **Step 7: Commit**

```bash
git add src/surface tests/integration/surface.test.ts
git commit -m "feat(surface): Playwright perception into normalized observations, refs, lease enforcement"
```

---

## Task 10: Control lease, session, escalation, and evidence

**Files:**
- Create: `src/session/control-lease.ts`, `src/session/escalation.ts`, `src/session/session.ts`, `src/model/escalation.ts`, `src/model/evidence.ts`, `src/evidence/sink.ts`
- Test: `tests/unit/session/control-lease.test.ts`, `tests/unit/evidence/sink.test.ts`

**Interfaces:**
- Produces: `class ControlLease` (methods per spec §3), `class EscalationService { raise(r: Omit<InterventionRequest,"id"|"createdAt">): InterventionRequest; get(id): InterventionRequest | undefined; list(): InterventionRequest[]; resolve(id, note: string): void }`
- Produces: `class FileEvidenceSink implements EvidenceSink { constructor(runDir: string); event(e: RunEvent): void; attach(kind, data): EvidenceRef; close(): void }`
- Produces: `class Session { readonly surface: Surface; readonly lease: ControlLease; readonly evidence: EvidenceSink; readonly runId: string }`

- [ ] **Step 1: Write the failing tests**

`tests/unit/session/control-lease.test.ts`:

```ts
it("starts unheld and grants to automation", () => { /* holder() === "none" then "automation" */ });
it("assertHeldBy throws ControlNotHeld for the wrong holder", () => {});
it("transfer rejects a transfer from a holder that does not hold it", () => {});
it("emits a change event on every transfer", () => {});
it("waitUntilHeldBy resolves when control returns", async () => {});
it("waitUntilHeldBy rejects on timeout", async () => {});
```

`tests/unit/evidence/sink.test.ts`:

```ts
it("appends one JSON object per line", () => {});
it("redacts sensitive values at the sink, so call sites cannot forget", () => {
  sink.event({ type: "action", stepId: "s1", actionKind: "fill", value: "123-45-6789", /*…*/ });
  expect(readFileSync(runDir + "/run.jsonl", "utf8")).not.toContain("123-45-6789");
  expect(readFileSync(runDir + "/run.jsonl", "utf8")).toContain("[REDACTED-SSN]");
});
it("writes observation attachments as separate files and returns a reference", () => {});
it("never writes a credential value even when one is passed", () => {});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/unit/session tests/unit/evidence` — Expected: FAIL.

- [ ] **Step 3: Implement `src/model/escalation.ts` and `src/model/evidence.ts`**

```ts
// escalation.ts
export type Holder = "automation" | "operator" | "none";
export interface LeaseChange { from: Holder; to: Holder; reason: string; at: string }

export type EscalationReason =
  | "agentStuck" | "noProgress" | "maxSteps" | "policyRequiresConfirmation"
  | "targetUnresolved" | "targetAmbiguous" | "checkpointFailed"
  | "unknownState" | "recoveryExhausted" | "riskyAction";

export interface InterventionRequest {
  readonly id: string; readonly runId: string;
  readonly mode: "discovery" | "replay";
  readonly capabilityId?: string; readonly goal: string;
  readonly stepId?: string; readonly stepIntent?: string;
  readonly reason: EscalationReason;
  readonly expected?: string; readonly observed?: string;
  readonly observationRef?: string; readonly screenshotRef?: string;
  readonly resumePlan: { readonly resumeAtStepId: string | null;
                         readonly mode: "retryStep" | "continueAfter" };
  readonly createdAt: string;
  readonly status: "open" | "in_progress" | "resolved" | "timedOut";
  readonly resolutionNote?: string;
}
```

`evidence.ts` declares the `RunEvent` union exactly as spec §3 lists it, plus
`interface EvidenceRef { kind: "screenshot" | "observation" | "html"; path: string }`.

- [ ] **Step 4: Implement the three session modules and the sink**

`FileEvidenceSink.event()` pipes every event through `redactEvent` (which applies `redactText` to
every string field and drops any field named `password`, `secret`, `token`, or `credential`) before
`appendFileSync`. This is the "cannot forget" property the test asserts.

- [ ] **Step 5: Run and confirm they pass**

Run: `npx vitest run tests/unit/session tests/unit/evidence` — Expected: 10 passed.

- [ ] **Step 6: Commit**

```bash
git add src/session src/evidence src/model/escalation.ts src/model/evidence.ts tests/unit/session tests/unit/evidence
git commit -m "feat(session): enforced control lease, escalation records, redacting evidence sink"
```

---

## Task 11: Capability store and profile merge

**Files:**
- Create: `src/store/capability-store.ts`
- Test: `tests/unit/store/capability-store.test.ts`

**Interfaces:**
- Produces: `class FileCapabilityStore { constructor(root: string); save(c: Capability): string; load(id: string, version?: string): Capability; list(): CapabilitySummary[]; loadProfile(ref: string): AppProfile; resolveOutcomes(c: Capability): OutcomeDefinition[] }`
- `version` omitted means highest semver. `resolveOutcomes` merges profile outcomes first, then artifact outcomes override by `code`, and sorts the result `hard` → `business` → `recoverable`.

- [ ] **Step 1: Write the failing test**

```ts
it("saves to capabilities/<id>/<version>.json and loads it back identically", () => {});
it("refuses to overwrite an existing version", () => { expect(() => store.save(same)).toThrow(/immutable/); });
it("load without a version returns the highest semver", () => {});
it("list returns id, version, title, status, risk, and the input names", () => {});
it("merges profile outcomes beneath artifact outcomes", () => {
  const codes = store.resolveOutcomes(cap).map((o) => o.code);
  expect(codes).toContain("SESSION_EXPIRED");     // from the profile
  expect(codes).toContain("MEMBER_NOT_FOUND");    // from the artifact
});
it("lets an artifact override a profile outcome by code", () => {});
it("orders outcomes hard, then business, then recoverable", () => {
  expect(store.resolveOutcomes(cap).map((o) => o.class))
    .toEqual([...].sort()); // hard first — a permission denial is never read as recoverable
});
it("rejects an artifact that fails schema validation on load", () => {});
```

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/unit/store/` — Expected: FAIL.
- [ ] **Step 3: Implement `src/store/capability-store.ts`.**
- [ ] **Step 4: Run and confirm it passes.** Expected: 8 passed.
- [ ] **Step 5: Commit**

```bash
git add src/store tests/unit/store
git commit -m "feat(store): versioned filesystem artifacts with profile outcome inheritance"
```

---

## Task 12: Replay engine — the production path

**Files:**
- Create: `src/model/result.ts`, `src/replay/waiter.ts`, `src/replay/outcome-checker.ts`, `src/replay/replay-engine.ts`
- Test: `tests/unit/replay/outcome-checker.test.ts`, `tests/integration/replay.test.ts`

This is the load-bearing task. `src/replay/` must not import `src/agent/`.

**Interfaces:**
- Produces: `ReplayResult` union exactly as spec §4.
- Produces: `waitFor(cond: Condition, deps: { observe: () => Promise<Observation> }, timeoutMs: number, pollMs: number): Promise<{ ok: boolean; observation: Observation; elapsedMs: number }>`
- Produces: `checkOutcomes(outcomes: readonly OutcomeDefinition[], stepId: string, o: Observation): OutcomeHit | null` where `interface OutcomeHit { definition: OutcomeDefinition; observed?: string }`
- Produces: `class ReplayEngine { constructor(deps: ReplayDeps); replay(c: Capability, inputs: Record<string, unknown>, opts: { unattended: boolean }): Promise<ReplayResult> }` with
  `interface ReplayDeps { surface: Surface; policy: PolicyEngine; evidence: EvidenceSink; store: FileCapabilityStore; escalation: EscalationService; lease: ControlLease; baseUrl: string; credentials: (ref: string) => string | undefined }`

- [ ] **Step 1: Write the failing unit test for the outcome checker**

```ts
it("returns null when no outcome matches", () => {});
it("detects a business outcome scoped to the matching step", () => {});
it("ignores an outcome scoped to a different step", () => {});
it("checks anyStep outcomes on every step", () => {});
it("prefers a hard outcome over a recoverable one that also matches", () => {
  // both detectors match; PERMISSION_DENIED must win over INTERSTITIAL_NOTICE
  expect(checkOutcomes(both, "s2", o)!.definition.code).toBe("PERMISSION_DENIED");
});
it("captures the application's own message text when the outcome declares one", () => {});
```

- [ ] **Step 2: Write the failing integration test**

`tests/integration/replay.test.ts` — the real proof. Boots the target app, launches a headless
surface, loads the reference artifact, and asserts each arm of the result contract:

```ts
it("replays the happy path and returns typed outputs", async () => {
  const r = await engine.replay(cap, { memberId: "100234" }, { unattended: true });
  expect(r.status).toBe("success");
  if (r.status === "success") {
    expect(r.outputs["savingsBalance"]).toBe(4182.55);       // number, not "$4,182.55"
    expect(r.outputs["memberName"]).toBe("Dana Whitfield");
    expect(r.outputs["savingsAccountNumber"]).toBe("4417");
  }
});

it("returns a business outcome, not a failure, for an unknown member", async () => {
  const r = await engine.replay(cap, { memberId: "999999" }, { unattended: true });
  expect(r.status).toBe("business_outcome");
  if (r.status === "business_outcome") {
    expect(r.code).toBe("MEMBER_NOT_FOUND");
    expect(r.message).toContain("No matching member");
  }
});

it("rejects a malformed input pre-flight, before opening a page", async () => {
  const r = await engine.replay(cap, { memberId: "abc" }, { unattended: true });
  expect(r.status).toBe("business_outcome");
  if (r.status === "business_outcome") expect(r.code).toBe("INVALID_INPUT");
});

it("returns the app's own validation outcome when the server rejects the input", async () => {
  // pattern relaxed for this case so the request actually reaches the server
  const r = await engine.replay(relaxed, { memberId: "12" }, { unattended: true });
  expect(r.status).toBe("business_outcome");
  if (r.status === "business_outcome") expect(r.code).toBe("INVALID_MEMBER_ID");
});

it("recovers from an unexpected interstitial and still succeeds", async () => {
  await arm("interstitial");
  const r = await engine.replay(cap, { memberId: "100234" }, { unattended: true });
  expect(r.status).toBe("success");
  const events = readEvents();
  expect(events.some((e) => e.type === "outcome_detected" && e.code === "INTERSTITIAL_NOTICE")).toBe(true);
});

it("re-authenticates and restarts after a session timeout", async () => {
  await arm("sessionExpired");
  const r = await engine.replay(cap, { memberId: "100234" }, { unattended: true });
  expect(r.status).toBe("success");
  expect(readEvents().filter((e) => e.type === "outcome_detected"
    && e.code === "SESSION_EXPIRED")).toHaveLength(1);
});

it("escalates rather than retrying on a permission denial", async () => {
  await arm("permissionDenied");
  const r = await engine.replay(cap, { memberId: "100234" }, { unattended: true });
  expect(r.status).toBe("escalated");
  if (r.status === "escalated") {
    const iv = escalation.get(r.interventionId)!;
    expect(iv.reason).toBe("riskyAction");   // hard outcome with escalate:true
    expect(iv.screenshotRef).toBeTruthy();
  }
});

it("waits through a transient slow load instead of failing", async () => {
  await arm("slowLoad");
  expect((await engine.replay(cap, { memberId: "100234" }, { unattended: true })).status)
    .toBe("success");
});

it("fails with a debuggable error when a target cannot be resolved", async () => {
  const broken = withBrokenTarget(cap, "s1");
  const r = await engine.replay(broken, { memberId: "100234" }, { unattended: false });
  expect(r.status).toBe("failed");
  if (r.status === "failed") {
    expect(r.error.stepId).toBe("s1");
    expect(r.error.code).toBe("TARGET_UNRESOLVED");
    expect(r.error.attempts.length).toBeGreaterThan(0);   // every strategy tried is listed
  }
});

it("fails with TARGET_AMBIGUOUS rather than clicking something arbitrary", async () => {});

it("blocks and does not execute when policy denies the action", async () => {
  const r = await new ReplayEngine({ ...deps, policy: denyAll })
    .replay(cap, { memberId: "100234" }, { unattended: true });
  expect(r.status).toBe("failed");
  if (r.status === "failed") expect(r.error.code).toBe("POLICY_BLOCKED");
});

it("requires confirmation for a draft capability", async () => {
  const r = await engine.replay({ ...cap, status: "draft" }, { memberId: "100234" },
                                { unattended: true });
  expect(r.status).toBe("escalated");
});

it("never calls an LLM — the engine has no llm dependency to call", async () => {
  expect(Object.keys(deps)).not.toContain("llm");
});

it("reports which strategy tier resolved each step", async () => {
  const r = await engine.replay(cap, { memberId: "100234" }, { unattended: true });
  if (r.status === "success") expect(r.resolutionReport.every((s) => s.tier === 0)).toBe(true);
});

it("produces identical step traces across two runs with the same input", async () => {
  const a = await engine.replay(cap, { memberId: "100234" }, { unattended: true });
  const b = await engine.replay(cap, { memberId: "100234" }, { unattended: true });
  expect(traceShape(a)).toEqual(traceShape(b));   // ids, actions, tiers, outcomes — not timings
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `npx vitest run tests/unit/replay tests/integration/replay.test.ts` — Expected: FAIL.

- [ ] **Step 4: Implement `src/model/result.ts`**

```ts
export type FailureCode =
  | "TARGET_UNRESOLVED" | "TARGET_AMBIGUOUS" | "CHECKPOINT_FAILED" | "WAIT_TIMEOUT"
  | "EXTRACTION_FAILED" | "POLICY_BLOCKED" | "UNKNOWN_STATE" | "RECOVERY_EXHAUSTED"
  | "BINDING_FAILED" | "ENTRY_FAILED";

export interface StepTrace {
  readonly stepId: string; readonly intent: string; readonly actionKind: string;
  readonly tier: number | null; readonly durationMs: number;
  readonly outcomeCode?: string; readonly checkpointPassed?: boolean;
}
export interface ResolutionReportEntry { readonly stepId: string; readonly tier: number;
  readonly strategyKind: string }

export type ReplayResult =
  | { readonly status: "success"; readonly outputs: Readonly<Record<string, unknown>>;
      readonly steps: readonly StepTrace[]; readonly evidenceRef: string;
      readonly resolutionReport: readonly ResolutionReportEntry[] }
  | { readonly status: "business_outcome"; readonly code: string; readonly message?: string;
      readonly outputs?: Readonly<Record<string, unknown>>; readonly steps: readonly StepTrace[];
      readonly evidenceRef: string }
  | { readonly status: "escalated"; readonly interventionId: string;
      readonly resumedBy?: "operator"; readonly finalStatus?: "success" | "failed";
      readonly steps: readonly StepTrace[]; readonly evidenceRef: string }
  | { readonly status: "failed";
      readonly error: { readonly stepId: string | null; readonly class: "hard";
                        readonly code: FailureCode; readonly expected: string;
                        readonly observed: string;
                        readonly attempts: readonly StrategyAttempt[] };
      readonly steps: readonly StepTrace[]; readonly evidenceRef: string };
```

- [ ] **Step 5: Implement `waiter.ts` and `outcome-checker.ts`**

`waitFor` polls `observe()` at a fixed `pollMs` until `evaluateCondition` passes or the budget is
spent. Fixed interval, no jitter, no backoff — determinism over cleverness.

`checkOutcomes` filters to in-scope outcomes, evaluates each `detect`, and returns the first hit in
`hard` → `business` → `recoverable` order (the store already sorted them; the checker does not
re-sort, it relies on that order and a test asserts it).

- [ ] **Step 6: Implement `replay-engine.ts`**

Follow the spec §4 flow exactly. Structure it so each phase is its own private method —
`#validateInputs`, `#enterApp`, `#runStep`, `#handleOutcome`, `#extractOutputs`, `#escalate` — so
the file stays readable and each phase is separately testable.

Critical details the tests pin down:
- input validation happens before the surface is touched; failure is `business_outcome/INVALID_INPUT`
- outcomes are checked **after** the action and **before** the checkpoint
- recovery attempts are counted per `(stepId, outcomeCode)`; exhaustion becomes `RECOVERY_EXHAUSTED`
- `resume: "restart"` re-enters the app and returns to step 0, preserving the attempt counter so a
  re-auth loop cannot spin
- escalation awaits `lease.waitUntilHeldBy("automation", operatorTimeoutSeconds * 1000)`, then
  re-observes and re-asserts the current step's checkpoint before continuing — it never assumes the
  human left the expected state
- every step appends a `StepTrace` regardless of how it ended

- [ ] **Step 7: Run and confirm they pass**

Run: `npx vitest run tests/unit/replay tests/integration/replay.test.ts` — Expected: 6 + 16 passed.

- [ ] **Step 8: Commit**

```bash
git add src/replay src/model/result.ts tests/unit/replay tests/integration/replay.test.ts
git commit -m "feat(replay): deterministic engine with outcome taxonomy and escalation"
```

---

## Task 13: LLM client and the Groq adapter

**Files:**
- Create: `src/agent/llm/llm-client.ts`, `src/agent/llm/prompt.ts`, `src/agent/llm/providers/groq.ts`, `anthropic.ts`, `openai.ts`, `index.ts`
- Test: `tests/unit/agent/prompt.test.ts`, `tests/unit/agent/provider-selection.test.ts`

**Interfaces:**
- Produces: `LlmClient`, `DecisionRequest`, `AgentDecision`, `ProposedAction` exactly as spec §3.
- Produces: `buildMessages(req: DecisionRequest): { system: string; user: string }`
- Produces: `parseDecision(raw: unknown): AgentDecision` — total; returns `{kind:"stuck", reason}` on anything unparseable rather than throwing.
- Produces: `createLlmClient(env: NodeJS.ProcessEnv): LlmClient`

- [ ] **Step 1: Write the failing tests**

```ts
// prompt.test.ts
it("renders each node as a numbered ref with role, name, and value", () => {
  expect(buildMessages(req).user).toContain('[n5] cell "Current Balance" = "$4,182.55"');
});
it("includes the goal and only the allowed action kinds", () => {});
it("never includes a raw sensitive input value", () => {
  expect(buildMessages({ ...req, inputs: { ssn: "123-45-6789" } }).user).not.toContain("123-45-6789");
});
it("summarises history compactly rather than replaying a full transcript", () => {
  expect(buildMessages(withLongHistory).user.length).toBeLessThan(8000);
});
it("parseDecision accepts a well-formed act decision", () => {});
it("parseDecision returns stuck for malformed JSON instead of throwing", () => {
  expect(parseDecision("not json").kind).toBe("stuck");
});
it("parseDecision rejects a decision naming a ref that is not in the observation", () => {});

// provider-selection.test.ts
it("selects groq from LLM_PROVIDER", () => expect(createLlmClient(env).provider).toBe("groq"));
it("throws a clear error when the provider's API key is missing", () =>
  expect(() => createLlmClient({ LLM_PROVIDER: "groq" })).toThrow(/GROQ_API_KEY/));
it("throws on an unknown provider, naming the supported ones", () => {});
```

- [ ] **Step 2: Run and confirm failure.** Expected: FAIL.

- [ ] **Step 3: Implement `llm-client.ts` and `prompt.ts`**

The prompt renders the redacted observation as a numbered list and instructs the model to reply with
one JSON object: `{"kind":"act","ref":"n5","action":{"kind":"click"},"rationale":"…"}`. State
explicitly in the system prompt that the model must **choose a ref from the list** and must not
invent selectors — this is the same invariant the type system enforces.

- [ ] **Step 4: Implement the three providers and `createLlmClient`**

Groq uses `groq-sdk` with `response_format: { type: "json_object" }` and `temperature: 0`. Anthropic
and OpenAI adapters are the same shape with their own message formatting and auth. If either grows
beyond ~60 lines, stop and leave it as a throwing stub with a comment naming exactly what it needs —
padding an abstraction to prove a point is worse than an honest seam.

- [ ] **Step 5: Run and confirm they pass.** Expected: 10 passed.

- [ ] **Step 6: Commit**

```bash
git add src/agent/llm tests/unit/agent
git commit -m "feat(agent): provider-neutral LLM seam with a working Groq adapter"
```

---

## Task 14: Recorder — refs into durable descriptors

**Files:**
- Create: `src/agent/recorder.ts`
- Test: `tests/unit/agent/recorder.test.ts`

**Interfaces:**
- Produces: `describeTarget(ref: Ref, o: Observation): TargetDescriptor | null` — deterministic rules, primary + ordered fallbacks + generated rationale. Returns `null` when no descriptor resolves back uniquely.
- Produces: `finalizeCapability(args: FinalizeArgs): Capability`

This is where locator robustness is actually produced. The model points; this module describes.

- [ ] **Step 1: Write the failing test**

```ts
it("prefers labelled for a form control with a label", () => {
  const t = describeTarget(midRef, loadObservation("member-search"))!;
  expect(t.primary.kind).toBe("labelled");
  expect(t.fallbacks.map((f) => f.kind)).toContain("roleAndName");
});

it("prefers anchoredCell for a table cell with row and column anchors", () => {
  expect(describeTarget(balanceRef, loadObservation("member-detail"))!.primary.kind)
    .toBe("anchoredCell");
});

it("self-validates: every descriptor it returns resolves back to the same ref, uniquely", () => {
  const o = loadObservation("member-detail");
  for (const n of o.nodes) {
    const t = describeTarget(n.ref, o);
    if (!t) continue;
    const r = resolveTarget(t, o);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ref).toBe(n.ref);
  }
});

it("returns null rather than a descriptor that cannot be replayed", () => {
  expect(describeTarget(ambiguousRef, loadObservation("ambiguous-buttons"))).toBeNull();
});

it("marks an ordinalInScope-only descriptor as weak", () => {
  expect(describeTarget(unnameableRef, o)!.rationale).toMatch(/positional|weak/i);
});

it("writes a rationale naming the strategy and why it is stable", () => {});

it("finalizeCapability emits status draft and never approved", () => {
  expect(finalizeCapability(args).status).toBe("draft");
});

it("finalizeCapability records provenance per step and never a credential", () => {});

it("finalizeCapability produces an artifact that parseCapability accepts", () => {
  expect(() => parseCapability(finalizeCapability(args))).not.toThrow();
});
```

The third test is the load-bearing one: it asserts the self-validation invariant across every node
in a real fixture, so the recorder cannot emit a descriptor that replay would fail on.

- [ ] **Step 2: Run and confirm failure.** Expected: FAIL.

- [ ] **Step 3: Implement `describeTarget`**

Candidate ladder, in preference order, each generated only when the node carries the metadata:
`anchoredCell` (row+column anchors) → `labelled` (label anchor) → `roleAndName` (a name) →
`roleInRegion` (sole node of its role in its region) → `ordinalInScope` (last resort, weak).

Build the full candidate list, then **filter it**: keep only candidates that, run through
`resolveTarget` against this very observation, resolve uniquely back to `ref`. The first survivor
becomes `primary`, the next up to three become `fallbacks`, and if nothing survives, return `null`.
Generate `rationale` from the chosen strategy plus the surface facts (no test IDs present, table
layout, etc.).

- [ ] **Step 4: Implement `finalizeCapability`.** Always `status: "draft"`; `risk` from the maximum
`classifyAction` over all steps; `provenance` per step; `weakTargets` listing every step whose
descriptor is `ordinalInScope`-primary.

- [ ] **Step 5: Run and confirm they pass.** Expected: 9 passed.

- [ ] **Step 6: Commit**

```bash
git add src/agent/recorder.ts tests/unit/agent/recorder.test.ts
git commit -m "feat(agent): deterministic descriptor generation with replay self-validation"
```

---

## Task 15: Discovery loop

**Files:**
- Create: `src/agent/discovery-loop.ts`
- Test: `tests/integration/discovery.test.ts` (with a scripted fake `LlmClient` — no network)

**Interfaces:**
- Produces: `class DiscoveryLoop { constructor(deps: DiscoveryDeps); discover(opts: { goal: string; inputs: Record<string,string>; maxSteps: number; wallClockMs: number }): Promise<DiscoveryResult> }`
- `interface DiscoveryDeps { surface; llm: LlmClient; policy; evidence; escalation; lease; baseUrl; }`
- `type DiscoveryResult = { status: "success"; capability: Capability; evidenceRef: string } | { status: "stopped"; reason: "maxSteps"|"timeout"|"noProgress"|"agentStuck"; evidenceRef: string } | { status: "escalated"; interventionId: string; evidenceRef: string }`

The fake client returns a scripted sequence, which keeps the loop's control flow under test and free.
The genuine Groq run happens in Task 17.

- [ ] **Step 1: Write the failing test**

```ts
it("completes a goal and emits a draft capability that parses", async () => {
  const r = await loop.discover({ goal: "read the savings balance for member 100234", /*…*/ });
  expect(r.status).toBe("success");
  if (r.status === "success") {
    expect(() => parseCapability(r.capability)).not.toThrow();
    expect(r.capability.status).toBe("draft");
  }
});
it("stops at maxSteps rather than looping forever", async () => {});
it("stops on no progress when the screen signature stops changing", async () => {});
it("escalates when the model reports stuck", async () => {});
it("feeds a policy denial back to the model instead of executing it", async () => {
  expect(scripted.lastRequest.history.some((h) => h.note?.includes("not permitted"))).toBe(true);
});
it("redacts the observation before it reaches the model", async () => {
  expect(JSON.stringify(scripted.seenRequests)).not.toContain("4417");
});
it("discards a decision naming a ref that is not in the current observation", async () => {});
it("writes an llm_decision event carrying the rationale for every step", async () => {});
it("captures a screenshot when the screen signature changes", async () => {});
```

- [ ] **Step 2: Run and confirm failure.** Expected: FAIL.
- [ ] **Step 3: Implement the loop** exactly per spec §4, including step 6 self-validation via
`describeTarget` (a `null` return means re-prompt with a note, not a crash).
- [ ] **Step 4: Run and confirm they pass.** Expected: 9 passed.
- [ ] **Step 5: Commit**

```bash
git add src/agent/discovery-loop.ts tests/integration/discovery.test.ts
git commit -m "feat(agent): bounded discovery loop with policy feedback and self-validating recording"
```

---

## Task 16: CLI and operator console

**Files:**
- Create: `apps/cli/index.ts`, `discover.ts`, `replay.ts`, `capabilities.ts`
- Create: `apps/operator-console/server.ts`, `ui.html`
- Test: `tests/integration/operator-handoff.test.ts`

**Interfaces:**
- CLI: `npm run cli -- discover --goal <text> --inputs <json> [--max-steps N]`,
  `npm run cli -- replay <id>[@version] --inputs <json> [--allow-draft]`,
  `npm run cli -- capabilities list|show <id>|schema <id>`.
  `schema` prints the JSON-Schema tool definition derived from `inputs`/`outputs` — the agent-facing
  contract, and the cheapest version of the "capability catalog" stretch goal.
- Exit codes: `0` success, `0` business outcome (code on stdout), `2` escalated, `3` failed.
- Console: `GET /` queue, `GET /intervention/:id`, `POST /intervention/:id/take`,
  `POST /intervention/:id/release`.

- [ ] **Step 1: Write the failing handoff test**

```ts
it("transfers control, records the human's actions, and resumes the same session", async () => {
  await arm("permissionDenied");
  const run = engine.replay(cap, { memberId: "100234" }, { unattended: true });   // will escalate

  const iv = await waitForIntervention();
  expect(iv.reason).toBeTruthy();
  expect(iv.screenshotRef).toBeTruthy();
  expect(iv.stepIntent).toBeTruthy();                       // enough context to act on

  await post(`/intervention/${iv.id}/take`);
  expect(lease.holder()).toBe("operator");
  await expect(surface.execute({ kind: "click", ref })).rejects.toThrow(/ControlNotHeld/);

  await clearFault();                                        // the "human" fixes the state
  await operatorPage.click("text=Retry");                    // a real action on the same page
  await post(`/intervention/${iv.id}/release`);

  expect(lease.holder()).toBe("automation");
  const r = await run;
  expect(r.status).toBe("escalated");
  if (r.status === "escalated") expect(r.finalStatus).toBe("success");

  const events = readEvents();
  expect(events.filter((e) => e.type === "control_transfer")).toHaveLength(2);
  expect(events.some((e) => e.type === "human_action")).toBe(true);
});

it("times out an intervention nobody picks up and reports it", async () => {});
it("proves the session is the same one — the browser context is never recreated", async () => {
  expect(contextIdBefore).toBe(contextIdAfter);
});
```

- [ ] **Step 2: Run and confirm failure.** Expected: FAIL.
- [ ] **Step 3: Implement the CLI** with `commander`, wiring the real dependency graph.
- [ ] **Step 4: Implement the operator console** — one HTML page polling the queue, plus the take
and release endpoints, both of which drive `ControlLease.transfer` and toggle
`surface.instrument()`. `instrument.ts` injects listeners reporting `click` and `change` events with
role, accessible name, and redacted value into the evidence sink as `human_action`.
- [ ] **Step 5: Run and confirm they pass.** Expected: 3 passed.
- [ ] **Step 6: Commit**

```bash
git add apps/cli apps/operator-console src/surface/web/instrument.ts tests/integration/operator-handoff.test.ts
git commit -m "feat(apps): CLI and operator console with real same-session control transfer"
```

---

## Task 17: The genuine discovery run, evidence, and the write-up

**Files:**
- Create: `evidence/**`, `README.md`, `REPORT.md`
- Test: `tests/unit/architecture.test.ts`

**Interfaces:**
- Consumes: everything.
- Produces: the deliverables in the exact paths the brief prescribes.

- [ ] **Step 1: Write the architecture test that proves the through-line**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

const importsOf = (file: string) =>
  [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);

describe("module boundaries", () => {
  it("replay/ never imports agent/", () => {
    for (const f of globSync("src/replay/**/*.ts"))
      expect(importsOf(f).some((i) => i.includes("/agent/"))).toBe(false);
  });
  it("agent/ never imports replay/", () => {
    for (const f of globSync("src/agent/**/*.ts"))
      expect(importsOf(f).some((i) => i.includes("/replay/"))).toBe(false);
  });
  it("replay/ never imports an LLM provider SDK", () => {
    for (const f of globSync("src/replay/**/*.ts"))
      expect(importsOf(f).some((i) => /groq|openai|anthropic/i.test(i))).toBe(false);
  });
  it("resolution/ imports only model/", () => {
    for (const f of globSync("src/resolution/**/*.ts"))
      for (const i of importsOf(f))
        if (i.startsWith(".")) expect(i).toMatch(/\/model\/|\.\/(strategies|resolve-target|evaluate)/);
  });
  it("surface/ never imports resolution/", () => {
    for (const f of globSync("src/surface/**/*.ts"))
      expect(importsOf(f).some((i) => i.includes("/resolution/"))).toBe(false);
  });
  it("model/ imports nothing outside model/ and zod", () => {});
});
```

- [ ] **Step 2: Run it; fix any boundary violation it finds.** Expected: 6 passed.

- [ ] **Step 3: Perform the genuine discovery run**

```bash
cp .env.example .env      # then set GROQ_API_KEY
npm run target-app &
npm run cli -- discover \
  --goal "look up member 100234 and read their current savings balance" \
  --inputs '{"memberId":"100234"}' \
  --evidence-dir evidence/discovery-run
```

Confirm: a real `llm_decision` event per step with the model's own rationale; a `draft` capability
written to `capabilities/`. Review it by hand, promote to `approved`, and fill in `review.*`. If the
model fails to reach the goal, tune the prompt — do not tune the target app to be easier.

- [ ] **Step 4: Perform the replay runs**

```bash
npm run cli -- replay corebank.member.readSavingsBalance --inputs '{"memberId":"100234"}'
npm run cli -- replay corebank.member.readSavingsBalance --inputs '{"memberId":"999999"}'
curl -X POST localhost:4000/_control/faults -d '{"fault":"permissionDenied"}' \
     -H 'content-type: application/json'
npm run cli -- replay corebank.member.readSavingsBalance --inputs '{"memberId":"100234"}'
```

Three runs: success with outputs, a `MEMBER_NOT_FOUND` business outcome, and an escalation. Then
drive the escalated one through the operator console to completion so the handoff has evidence too.

- [ ] **Step 5: Assemble `/evidence/`**

```
evidence/
  README.md                     the reading order, so a reviewer can follow the through-line
  discovery-run/                run.jsonl, observations/, screenshots/, capability-draft.json
  replay-success/               run.jsonl, result.json, screenshots/
  replay-business-outcome/      run.jsonl, result.json
  replay-escalation/            run.jsonl, result.json, intervention.json, screenshots/
```

Verify no evidence file contains a credential or an unredacted account number:
`grep -rE "(GROQ_API_KEY|demo-pass|[0-9]{9,})" evidence/ | grep -v REDACTED` must print nothing.

- [ ] **Step 6: Write `/README.md`** — prerequisites, setup, `.env`, how to run without an API key
(replay works with no key; discovery needs one), and the exact demo path from Steps 3–4.

- [ ] **Step 7: Write `/REPORT.md`** — the seven prescribed headings: Architecture, Artifact schema,
Determinism & error handling, Heterogeneity & multi-tenant, Escalation & handoff, Safety, Cuts.
Source it from the spec, but write it fresh and keep it to 1–3 pages. Under **Cuts**, be specific and
honest: no desktop surface (seam documented in `src/surface/desktop/README.md`), no remote
co-browsing (local operator console instead), no tenant overlay *implementation* (the profile-merge
mechanism exists and the design is described), pattern-based rather than general redaction, and the
`classifyAction` heuristic's limits.

- [ ] **Step 8: Full verification**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: clean typecheck, clean lint, all tests passing. Do not claim completion until this exact
command sequence has been run and its output read.

- [ ] **Step 9: Commit and push**

```bash
git add -A
git commit -m "docs: evidence from live discovery and replay runs, README, and design report"
gh repo create corebank-capability-engine --public --source=. --push
```

---

## Self-Review

**Spec coverage.** §1 stack → Task 1. §2 architecture and boundaries → Tasks 1, 17. §3 interfaces →
Tasks 1, 3–7, 9–13. §4 discovery flow → Tasks 14, 15. §4 replay flow → Task 12. §4 escalation flow →
Tasks 10, 16. §5 artifact schema → Task 6. §5 outcome model → Tasks 6, 11, 12. §5 navigation
semantics → Tasks 6, 12. §6 target app → Task 8. §7 trade-offs → Task 17 (REPORT.md). §8 deliverables
→ Task 17. Brief §3.5 evidence → Task 10 (sink) and Task 17 (assembly). Brief §8 stretch — the
capability catalog appears as `capabilities schema` in Task 16, deliberately the cheapest version.

**Placeholder scan.** No "TBD" or "handle edge cases". Tasks 8, 9, 11, 12, 16 describe some
implementations in precise prose rather than full code — those are long files (an HTML app, a DOM
walker, a 400-line engine) where the tests are the specification and full listings would make the
plan unreadable. Every one of them has complete test code, exact file paths, and named interfaces,
which is what an implementer actually needs.

**Type consistency.** `resolveTarget`, `evaluateCondition`, `matchText`, `applyTransforms`,
`bindValue`, `matchStrategy`, `describeTarget`, `finalizeCapability`, `ReplayEngine.replay`,
`DiscoveryLoop.discover`, `LlmClient.decide`, `ControlLease`, `EvidenceSink`, `PolicyEngine`,
`FileCapabilityStore` are used identically everywhere they appear. `Resolution`, `ReplayResult`,
`ConditionResult`, `TransformResult`, `BindResult`, `PolicyVerdict` are all discriminated unions
returned as values — no function in the system signals a domain outcome by throwing.

One duplication is deliberate and flagged in Task 6: `classifyAction` exists in both `model/`
(inlined, to keep `model/` dependency-free) and `policy/risk.ts`. Task 7's test asserts the two
agree.
