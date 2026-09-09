import type { ValueSource } from "../model/action.js";
import type {
  ConcreteTargetDescriptor,
  ConcreteTargetStrategy,
  TargetDescriptor,
  TargetParam,
  TargetStrategy,
} from "../model/target.js";
import type { Condition, ConcreteCondition, LeafCondition } from "../model/condition.js";

export interface BindContext {
  readonly inputs: Readonly<Record<string, string | number | boolean>>;
  readonly outputs: Readonly<Record<string, unknown>>;
  /** Resolved from the environment at run time. Never read from, or written to, an artifact. */
  readonly credentials: (ref: string) => string | undefined;
}

export type BindResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: string };

export function bindValue(v: ValueSource, ctx: BindContext): BindResult {
  switch (v.from) {
    case "literal":
      return { ok: true, value: v.value };
    case "input": {
      const x = ctx.inputs[v.name];
      return x === undefined
        ? { ok: false, error: `no value supplied for input "${v.name}"` }
        : { ok: true, value: String(x) };
    }
    case "output": {
      const x = ctx.outputs[v.name];
      return x === undefined
        ? { ok: false, error: `output "${v.name}" has not been extracted yet` }
        : { ok: true, value: String(x) };
    }
    case "credential": {
      const x = ctx.credentials(v.ref);
      return x === undefined
        ? { ok: false, error: `credential "${v.ref}" is not configured` }
        : { ok: true, value: x };
    }
  }
}

const isValueSource = (p: TargetParam): p is ValueSource =>
  typeof p === "object" && p !== null && "from" in p;

export type BindTargetResult =
  | { readonly ok: true; readonly target: ConcreteTargetDescriptor }
  | { readonly ok: false; readonly error: string };

function bindStrategy(
  s: TargetStrategy,
  ctx: BindContext,
): { ok: true; strategy: ConcreteTargetStrategy } | { ok: false; error: string } {
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(s.params)) {
    if (!isValueSource(v)) {
      params[k] = v;
      continue;
    }
    const bound = bindValue(v, ctx);
    if (!bound.ok) return { ok: false, error: `strategy param "${k}": ${bound.error}` };
    params[k] = bound.value;
  }
  return { ok: true, strategy: { kind: s.kind, params, ...(s.match ? { match: s.match } : {}) } };
}

/**
 * Materializes a stored descriptor into a concrete one. Kept separate from resolution so
 * that resolveTarget remains a pure total function of (concrete descriptor, observation).
 */
export function bindTarget(t: TargetDescriptor, ctx: BindContext): BindTargetResult {
  const primary = bindStrategy(t.primary, ctx);
  if (!primary.ok) return { ok: false, error: primary.error };

  const fallbacks: ConcreteTargetStrategy[] = [];
  for (const f of t.fallbacks) {
    const bound = bindStrategy(f, ctx);
    if (!bound.ok) return { ok: false, error: bound.error };
    fallbacks.push(bound.strategy);
  }

  return {
    ok: true,
    target: {
      scope: t.scope,
      expectedRole: t.expectedRole,
      primary: primary.strategy,
      fallbacks,
      cardinality: t.cardinality,
      ...(t.nth === undefined ? {} : { nth: t.nth }),
      rationale: t.rationale,
    },
  };
}

export type BindConditionResult =
  | { readonly ok: true; readonly condition: ConcreteCondition }
  | { readonly ok: false; readonly error: string };

function bindLeaf(
  c: LeafCondition,
  ctx: BindContext,
): { ok: true; leaf: Extract<ConcreteCondition, { kind: string }> } | { ok: false; error: string } {
  if (c.kind === "location") return { ok: true, leaf: c };
  const bound = bindTarget(c.target, ctx);
  if (!bound.ok) return { ok: false, error: bound.error };
  switch (c.kind) {
    case "exists":
    case "absent":
      return { ok: true, leaf: { kind: c.kind, target: bound.target } };
    case "text":
    case "value":
      return { ok: true, leaf: { kind: c.kind, target: bound.target, match: c.match } };
  }
}

export function bindCondition(c: Condition, ctx: BindContext): BindConditionResult {
  if (c.kind === "all" || c.kind === "any") {
    const of: Extract<ConcreteCondition, { kind: string }>[] = [];
    for (const leaf of c.of) {
      const bound = bindLeaf(leaf, ctx);
      if (!bound.ok) return { ok: false, error: bound.error };
      of.push(bound.leaf);
    }
    return { ok: true, condition: { kind: c.kind, of } as ConcreteCondition };
  }
  const bound = bindLeaf(c, ctx);
  return bound.ok ? { ok: true, condition: bound.leaf } : { ok: false, error: bound.error };
}
