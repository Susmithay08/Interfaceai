import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Observation } from "../../src/model/observation.js";

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_NAMES = [
  "member-search",
  "search-results",
  "member-detail",
  "not-found",
  "validation-error",
  "session-expired",
  "ambiguous-buttons",
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

export function loadObservation(name: string): Observation {
  const raw = readFileSync(join(here, "observations", `${name}.json`), "utf8");
  return JSON.parse(raw) as Observation;
}

export function refOf(o: Observation, predicate: (n: Observation["nodes"][number]) => boolean) {
  const hit = o.nodes.find(predicate);
  if (!hit) throw new Error("fixture node not found");
  return hit.ref;
}
