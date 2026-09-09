import type { OutcomeDefinition } from "../model/capability.js";
import type { Observation } from "../model/observation.js";
import { evaluateCondition } from "../resolution/evaluate.js";
import { resolveTarget } from "../resolution/resolve-target.js";
import { applyTransforms, readNode } from "../resolution/extract.js";
import { bindCondition, bindTarget, type BindContext } from "../resolution/bind.js";

export interface OutcomeHit {
  readonly definition: OutcomeDefinition;
  readonly observed?: string;
  readonly message?: string;
}

const inScope = (o: OutcomeDefinition, stepId: string): boolean =>
  o.scope === "anyStep" || o.scope.steps.includes(stepId);

/**
 * Evaluates the artifact's declared outcome table against the current state.
 *
 * The engine hardcodes no application conditions whatsoever - only the machinery. The
 * outcomes arrive already ordered hard -> business -> recoverable by the store, and the
 * first hit wins, so a permission denial can never be mistaken for a recoverable blip.
 */
export function checkOutcomes(
  outcomes: readonly OutcomeDefinition[],
  stepId: string,
  observation: Observation,
  ctx: BindContext,
): OutcomeHit | null {
  for (const definition of outcomes) {
    if (!inScope(definition, stepId)) continue;

    const bound = bindCondition(definition.detect, ctx);
    if (!bound.ok) continue; // an unbindable detector cannot fire; it is not a match

    const result = evaluateCondition(bound.condition, observation);
    if (!result.passed) continue;

    const message = definition.message
      ? extractMessage(definition, observation, ctx)
      : undefined;

    return {
      definition,
      ...(result.observed === undefined ? {} : { observed: result.observed }),
      ...(message === undefined ? {} : { message }),
    };
  }
  return null;
}

/** Returns the application's own wording, so the caller can relay it verbatim. */
function extractMessage(
  definition: OutcomeDefinition,
  observation: Observation,
  ctx: BindContext,
): string | undefined {
  const spec = definition.message;
  if (!spec) return undefined;

  const bound = bindTarget(spec.target, ctx);
  if (!bound.ok) return undefined;

  const resolution = resolveTarget(bound.target, observation);
  if (!resolution.ok) return undefined;

  const node = observation.nodes.find((n) => n.ref === resolution.ref);
  if (!node) return undefined;

  const raw = readNode(node, spec.read);
  if (raw === undefined) return undefined;

  const transformed = applyTransforms(raw, spec.transform ?? []);
  return transformed.ok ? String(transformed.value) : raw;
}
