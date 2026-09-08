import type { Observation, ScopePath, UiNode } from "../model/observation.js";
import { sameScope } from "../model/observation.js";
import type { MatchMode, TargetStrategy } from "../model/target.js";

export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function textEquals(
  actual: string | undefined,
  expected: string,
  mode: MatchMode = "normalized",
): boolean {
  if (actual === undefined) return false;
  if (mode === "exact") return actual === expected;
  const a = normalizeText(actual).toLowerCase();
  const b = normalizeText(expected).toLowerCase();
  return mode === "prefix" ? a.startsWith(b) : a === b;
}

const anchorText = (n: UiNode, kind: string): string[] =>
  n.anchors.filter((a) => a.kind === kind).map((a) => a.text);

const str = (p: Readonly<Record<string, string | number>>, k: string): string => String(p[k] ?? "");

/**
 * Every node in `scope` matching `s`, in observation order.
 *
 * Role is deliberately NOT checked here - resolveTarget checks it separately so that
 * "matched the wrong kind of thing" is distinguishable from "matched nothing".
 */
export function matchStrategy(s: TargetStrategy, scope: ScopePath, o: Observation): UiNode[] {
  const mode = s.match ?? "normalized";
  const inScope = o.nodes.filter((n) => sameScope(n.scope, scope));

  switch (s.kind) {
    case "roleAndName":
      return inScope.filter(
        (n) => n.role === str(s.params, "role") && textEquals(n.name, str(s.params, "name"), mode),
      );

    case "labelled":
      return inScope.filter((n) =>
        anchorText(n, "label").some((t) => textEquals(t, str(s.params, "label"), mode)),
      );

    case "anchoredCell":
      return inScope.filter(
        (n) =>
          anchorText(n, "rowHeader").some((t) => textEquals(t, str(s.params, "rowKey"), mode)) &&
          anchorText(n, "columnHeader").some((t) =>
            textEquals(t, str(s.params, "columnHeader"), mode),
          ),
      );

    case "roleInRegion": {
      const region = str(s.params, "region");
      const role = str(s.params, "role");
      return o.nodes.filter(
        (n) =>
          sameScope(n.scope, { path: scope.path }) &&
          n.scope.region?.value === region &&
          n.role === role,
      );
    }

    case "ordinalInScope": {
      const hits = inScope.filter((n) => n.role === str(s.params, "role"));
      const hit = hits[Number(s.params["index"] ?? 0)];
      return hit ? [hit] : [];
    }
  }
}
