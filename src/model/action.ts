import type { Ref } from "./ids.js";
import type { TargetDescriptor } from "./target.js";
import type { Condition } from "./condition.js";

export type KeyName = "Enter" | "Tab" | "Escape" | "ArrowDown" | "ArrowUp";

/**
 * Where a value comes from at replay time. A typed union rather than string
 * interpolation: reviewable, no injection surface, and it makes the credential
 * channel explicit and separate from anything that could be persisted.
 */
export type ValueSource =
  | { readonly from: "input"; readonly name: string }
  | { readonly from: "literal"; readonly value: string }
  | { readonly from: "output"; readonly name: string }
  | { readonly from: "credential"; readonly ref: string };

export interface PathTemplate {
  /** Path only - never an absolute URL. The base URL arrives at replay time. */
  readonly path: string;
  readonly params?: Readonly<Record<string, ValueSource>>;
}

/** PERSISTENT. Appears in artifacts. Carries TargetDescriptors, never refs. */
export type StepAction =
  | { readonly kind: "click"; readonly target: TargetDescriptor }
  | { readonly kind: "fill"; readonly target: TargetDescriptor; readonly value: ValueSource }
  | { readonly kind: "select"; readonly target: TargetDescriptor; readonly value: ValueSource }
  | { readonly kind: "pressKey"; readonly key: KeyName; readonly target?: TargetDescriptor }
  | {
      readonly kind: "wait";
      readonly for: Condition;
      readonly timeoutMs: number;
      readonly pollMs: number;
    }
  | { readonly kind: "navigate"; readonly path: PathTemplate; readonly rationale: string }
  | { readonly kind: "dismiss"; readonly target: TargetDescriptor };

/** EPHEMERAL. Never serialized. Carries refs. The only thing a Surface ever executes. */
export type ResolvedAction =
  | { readonly kind: "click"; readonly ref: Ref }
  | { readonly kind: "fill"; readonly ref: Ref; readonly value: string }
  | { readonly kind: "select"; readonly ref: Ref; readonly value: string }
  | { readonly kind: "pressKey"; readonly key: KeyName; readonly ref?: Ref }
  | { readonly kind: "navigate"; readonly url: string }
  | { readonly kind: "dismiss"; readonly ref: Ref };

export type ActionKind = StepAction["kind"];
