import type { ValueSource } from "../model/action.js";

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
