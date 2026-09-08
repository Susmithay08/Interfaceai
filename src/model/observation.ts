import type { Ref } from "./ids.js";

/**
 * One containment step (frame / window / pane), identified by HOW it is addressed so a
 * future adapter can map it back to a native handle. Never a CSS or XPath selector.
 */
export type ScopeSegment =
  | { readonly by: "name"; readonly value: string }
  | { readonly by: "title"; readonly value: string }
  | { readonly by: "urlPath"; readonly value: string }
  | { readonly by: "index"; readonly value: number };

export interface ScopeRegion {
  readonly by: "landmark" | "heading";
  readonly value: string;
}

export interface ScopePath {
  readonly path: readonly ScopeSegment[];
  readonly region?: ScopeRegion;
}

export type AnchorKind =
  | "label"
  | "rowHeader"
  | "columnHeader"
  | "sectionHeading"
  | "precedingText";

/** What a node sits next to or under. The raw material for semantic targeting. */
export interface Anchor {
  readonly kind: AnchorKind;
  readonly text: string;
}

export interface NodeState {
  readonly visible: boolean;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  readonly expanded?: boolean;
  readonly readonly?: boolean;
  readonly required?: boolean;
}

export interface UiNode {
  readonly ref: Ref;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly state: NodeState;
  readonly scope: ScopePath;
  readonly anchors: readonly Anchor[];
  /** Allowlisted extras only (inputType, tagName). Never a selector. */
  readonly attrs?: Readonly<Record<string, string>>;
}

export interface Observation {
  readonly observationId: string;
  readonly surfaceKind: "web" | "desktop";
  readonly locationHint?: string;
  readonly title?: string;
  /** Hash of structure only (roles + scopes), never values, so it is stable across members. */
  readonly screenSignature: string;
  readonly nodes: readonly UiNode[];
  readonly capturedAt: string;
}

export function scopeKey(s: ScopePath): string {
  const frames = s.path.map((seg) => `${seg.by}:${seg.value}`).join(">");
  return s.region ? `${frames}|region:${s.region.by}:${s.region.value}` : frames;
}

/**
 * Is `node` inside `target`?
 * A node carrying a region is still inside the region-less parent scope; a target that
 * demands a region only accepts nodes in that region.
 */
export function sameScope(node: ScopePath, target: ScopePath): boolean {
  if (node.path.length !== target.path.length) return false;
  for (let i = 0; i < target.path.length; i++) {
    const a = node.path[i];
    const b = target.path[i];
    if (!a || !b || a.by !== b.by || a.value !== b.value) return false;
  }
  if (!target.region) return true;
  return node.region?.by === target.region.by && node.region?.value === target.region.value;
}
