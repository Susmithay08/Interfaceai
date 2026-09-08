/**
 * Closed union of deterministic value transforms. No eval, no arbitrary JavaScript,
 * and never an LLM: extraction on the replay path must be reproducible.
 */
export type Transform =
  | { readonly kind: "trim" }
  | { readonly kind: "normalizeWhitespace" }
  | { readonly kind: "stripPrefix"; readonly value: string }
  | { readonly kind: "stripSuffix"; readonly value: string }
  | { readonly kind: "extractGroup"; readonly pattern: string; readonly group: number }
  | { readonly kind: "currencyToNumber"; readonly currency: "USD" }
  | { readonly kind: "toNumber" }
  | { readonly kind: "parseDate"; readonly format: "MM/DD/YYYY" | "YYYY-MM-DD" };
