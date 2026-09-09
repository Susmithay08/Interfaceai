import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseAppProfile,
  parseCapability,
  type AppProfile,
  type Capability,
  type OutcomeDefinition,
} from "../model/capability.js";

export interface CapabilitySummary {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly status: Capability["status"];
  readonly risk: Capability["risk"];
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

const compareSemver = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/** Outcome evaluation order: a permission denial must never be read as a recoverable blip. */
const CLASS_ORDER: Record<OutcomeDefinition["class"], number> = {
  hard: 0,
  business: 1,
  recoverable: 2,
};

export class FileCapabilityStore {
  constructor(
    private readonly root: string = "capabilities",
    private readonly profileRoot: string = "profiles",
  ) {}

  save(c: Capability): string {
    const dir = join(this.root, c.id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${c.version}.json`);
    if (existsSync(path)) {
      throw new Error(
        `${c.id}@${c.version} already exists and artifacts are immutable - bump the version`,
      );
    }
    writeFileSync(path, JSON.stringify(c, null, 2), "utf8");
    return path;
  }

  /** Overwrites in place. Used only for review promotion (draft -> approved), never by discovery. */
  overwrite(c: Capability): string {
    const dir = join(this.root, c.id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${c.version}.json`);
    writeFileSync(path, JSON.stringify(c, null, 2), "utf8");
    return path;
  }

  versions(id: string): string[] {
    const dir = join(this.root, id);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort(compareSemver);
  }

  load(id: string, version?: string): Capability {
    const chosen = version ?? this.versions(id).at(-1);
    if (!chosen) throw new Error(`no versions of capability "${id}" found under ${this.root}`);
    const path = join(this.root, id, `${chosen}.json`);
    if (!existsSync(path)) throw new Error(`capability ${id}@${chosen} not found at ${path}`);
    return parseCapability(JSON.parse(readFileSync(path, "utf8")));
  }

  list(): CapabilitySummary[] {
    if (!existsSync(this.root)) return [];
    const out: CapabilitySummary[] = [];
    for (const id of readdirSync(this.root)) {
      for (const version of this.versions(id)) {
        try {
          const c = this.load(id, version);
          out.push({
            id: c.id,
            version: c.version,
            title: c.title,
            status: c.status,
            risk: c.risk,
            inputs: Object.keys(c.inputs),
            outputs: Object.keys(c.outputs),
          });
        } catch {
          // A malformed artifact must not take the whole catalog down.
        }
      }
    }
    return out;
  }

  loadProfile(ref: string): AppProfile {
    const path = join(this.profileRoot, `${ref.replace("@", "-")}.json`);
    if (!existsSync(path)) throw new Error(`app profile "${ref}" not found at ${path}`);
    return parseAppProfile(JSON.parse(readFileSync(path, "utf8")));
  }

  /**
   * Profile outcomes load first; the artifact's own outcomes override by code. This is the
   * multi-tenant reuse point: SESSION_EXPIRED is declared once per vendor product, not once
   * per capability, and a tenant can specialize any single outcome without a re-record.
   */
  resolveOutcomes(c: Capability): OutcomeDefinition[] {
    const byCode = new Map<string, OutcomeDefinition>();

    if (c.inheritsOutcomesFrom) {
      for (const o of this.loadProfile(c.inheritsOutcomesFrom).outcomes) byCode.set(o.code, o);
    }
    for (const o of c.outcomes) byCode.set(o.code, o);

    return [...byCode.values()].sort((a, b) => CLASS_ORDER[a.class] - CLASS_ORDER[b.class]);
  }
}
