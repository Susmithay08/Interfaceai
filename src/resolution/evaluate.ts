import type {
  ConcreteCondition,
  ConcreteLeafCondition,
  ConditionResult,
  TextMatcher,
} from "../model/condition.js";
import type { Observation, UiNode } from "../model/observation.js";
import { resolveTarget } from "./resolve-target.js";
import { normalizeText } from "./strategies.js";

export function matchText(actual: string | undefined, m: TextMatcher): boolean {
  if (actual === undefined) return false;
  const prep = (s: string): string => {
    const w = m.normalizeWhitespace === false ? s : normalizeText(s);
    return m.caseSensitive ? w : w.toLowerCase();
  };
  const a = prep(actual);
  const b = prep(m.value);
  switch (m.op) {
    case "equals":
      return a === b;
    case "contains":
      return a.includes(b);
    case "startsWith":
      return a.startsWith(b);
    case "regex":
      return new RegExp(m.value, m.caseSensitive ? "" : "i").test(actual);
  }
}

const nodeText = (n: UiNode): string | undefined => n.value ?? n.name;

function evaluateLeaf(c: ConcreteLeafCondition, o: Observation): ConditionResult {
  if (c.kind === "location") {
    return {
      passed: matchText(o.locationHint, c.match),
      observed: o.locationHint ?? "",
      detail: `location ${c.match.op} "${c.match.value}"`,
    };
  }

  const r = resolveTarget(c.target, o);
  if (!r.ok) {
    // An unresolvable target is exactly what "absent" is asserting, and is a failure
    // for every other condition kind. Either way it is a value, never a throw.
    return {
      passed: c.kind === "absent",
      detail: `target ${r.reason} (${r.attempts.length} strategies tried)`,
    };
  }
  const node = o.nodes.find((n) => n.ref === r.ref)!;

  switch (c.kind) {
    case "exists":
      return { passed: true, detail: `resolved at tier ${r.tier}` };
    case "absent":
      return {
        passed: false,
        observed: nodeText(node),
        detail: `target unexpectedly present (tier ${r.tier})`,
      };
    case "text": {
      const actual = nodeText(node);
      return {
        passed: matchText(actual, c.match),
        observed: actual,
        detail: `text ${c.match.op} "${c.match.value}"`,
      };
    }
    case "value":
      return {
        passed: matchText(node.value, c.match),
        observed: node.value,
        detail: `value ${c.match.op} "${c.match.value}"`,
      };
  }
}

export function evaluateCondition(c: ConcreteCondition, o: Observation): ConditionResult {
  if (c.kind === "all" || c.kind === "any") {
    const results = c.of.map((leaf) => evaluateLeaf(leaf, o));
    const passed = c.kind === "all" ? results.every((r) => r.passed) : results.some((r) => r.passed);
    const blame = results.find((r) => r.passed !== passed) ?? results[0];
    return {
      passed,
      observed: blame?.observed,
      detail: `${c.kind}: ${results.map((r) => `${r.passed ? "ok" : "FAIL"} ${r.detail}`).join("; ")}`,
    };
  }
  return evaluateLeaf(c, o);
}
