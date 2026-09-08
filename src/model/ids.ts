/** Opaque handle to a node within ONE observation. Refs die when the next observation is taken. */
export type Ref = string & { readonly __brand: "Ref" };

export const asRef = (s: string): Ref => s as Ref;

export type StepId = string;
