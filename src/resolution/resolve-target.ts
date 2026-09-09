import type { Observation, UiNode } from "../model/observation.js";
import type {
  ConcreteTargetDescriptor,
  ConcreteTargetStrategy,
  Resolution,
  StrategyAttempt,
} from "../model/target.js";
import { matchStrategy } from "./strategies.js";

/**
 * Pure. Same descriptor + same observation always produces the same resolution, which is
 * what makes replay determinism provable offline from recorded evidence, with no browser.
 *
 * Never throws and never guesses: an ambiguous match is a failure value, not a coin flip.
 */
export function resolveTarget(t: ConcreteTargetDescriptor, o: Observation): Resolution {
  const attempts: StrategyAttempt[] = [];
  const ladder: ConcreteTargetStrategy[] = [t.primary, ...t.fallbacks];

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
      // Do not short-circuit: a narrower fallback may still disambiguate.
      attempts.push({ strategy, tier, matchCount: correctRole.length, outcome: "ambiguous" });
      continue;
    }

    attempts.push({ strategy, tier, matchCount: 1, outcome: "matched" });
    return { ok: true, ref: correctRole[0]!.ref, tier, strategyUsed: strategy, attempts };
  }

  const last = attempts[attempts.length - 1];
  const reason = attempts.some((a) => a.outcome === "ambiguous")
    ? "ambiguous"
    : last?.outcome === "roleMismatch"
      ? "roleMismatch"
      : "notFound";
  const ambiguous = attempts.find((a) => a.outcome === "ambiguous");
  return {
    ok: false,
    reason,
    matchCount: (reason === "ambiguous" ? ambiguous?.matchCount : last?.matchCount) ?? 0,
    attempts,
  };
}
