import type { Transform } from "../model/transform.js";
import type { UiNode } from "../model/observation.js";
import { normalizeText } from "./strategies.js";

export type TransformResult =
  | { readonly ok: true; readonly value: string | number }
  | { readonly ok: false; readonly error: string };

export function readNode(n: UiNode, read: "text" | "value" | "name"): string | undefined {
  return read === "value" ? n.value : read === "name" ? n.name : (n.value ?? n.name);
}

/** Ordered pipeline of closed-union transforms. Deterministic, and never an LLM. */
export function applyTransforms(input: string, ts: readonly Transform[]): TransformResult {
  let cur: string | number = input;

  for (const t of ts) {
    if (typeof cur === "number" && t.kind !== "toNumber") {
      return { ok: false, error: `${t.kind}: input is already a number` };
    }
    const s: string = String(cur);

    switch (t.kind) {
      case "trim":
        cur = s.trim();
        break;
      case "normalizeWhitespace":
        cur = normalizeText(s);
        break;
      case "stripPrefix":
        cur = s.startsWith(t.value) ? s.slice(t.value.length) : s;
        break;
      case "stripSuffix":
        cur = s.endsWith(t.value) ? s.slice(0, -t.value.length) : s;
        break;
      case "extractGroup": {
        const m = new RegExp(t.pattern).exec(s);
        const g = m?.[t.group];
        if (g === undefined) {
          return { ok: false, error: `extractGroup: no group ${t.group} in "${s}"` };
        }
        cur = g;
        break;
      }
      case "currencyToNumber": {
        const n: number = Number(s.replace(/[$,\s]/g, ""));
        if (!Number.isFinite(n) || s.trim() === "") {
          return { ok: false, error: `currencyToNumber: cannot parse "${s}"` };
        }
        cur = n;
        break;
      }
      case "toNumber": {
        const n: number = Number(String(cur).replace(/[,\s]/g, ""));
        if (!Number.isFinite(n) || String(cur).trim() === "") {
          return { ok: false, error: `toNumber: cannot parse "${String(cur)}"` };
        }
        cur = n;
        break;
      }
      case "parseDate": {
        const m =
          t.format === "MM/DD/YYYY"
            ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim())
            : /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
        if (!m) return { ok: false, error: `parseDate: "${s}" is not ${t.format}` };
        cur = t.format === "MM/DD/YYYY" ? `${m[3]}-${m[1]}-${m[2]}` : `${m[1]}-${m[2]}-${m[3]}`;
        break;
      }
    }
  }
  return { ok: true, value: cur };
}
