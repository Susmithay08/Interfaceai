import { asRef } from "../../model/ids.js";
import type { AgentDecision, DecisionRequest, ObservedNode } from "./llm-client.js";

export const SYSTEM_PROMPT = `You operate a legacy bank back-office web application by
choosing ONE action at a time.

You are shown a numbered list of the controls currently on screen. Each line looks like:

  [ref] role "name" = "value"  (frame: f, region: r, anchors: ...)

RULES
1. You MUST choose a ref from the list. Never invent a ref, a CSS selector, or an XPath.
   You point at a control; the system decides how to identify it durably.
2. Reply with exactly ONE JSON object and nothing else.
3. To type a value, use {"kind":"act","ref":"<ref>","action":{"kind":"fill",
   "inputName":"<one of the declared input names>"},"rationale":"..."}.
   Never invent the literal text - name the input and the system supplies its value.
4. To click, use {"kind":"act","ref":"<ref>","action":{"kind":"click"},"rationale":"..."}.
5. To record a value the goal asks for, use
   {"kind":"extract","ref":"<ref>","field":"<camelCaseName>","as":"string"|"number",
    "rationale":"..."}.
6. When the goal is fully achieved AND every value it asked for has been extracted, reply
   {"kind":"done","summary":"..."}.
7. If you cannot make progress, reply {"kind":"stuck","reason":"..."}. Do not guess.

Prefer controls that are clearly labelled. Work one step at a time and check the screen
after each action.`;

const renderNode = (n: ObservedNode): string => {
  const parts = [`[${n.ref}] ${n.role}`];
  if (n.name) parts.push(`"${n.name}"`);
  if (n.value && n.value !== n.name) parts.push(`= "${n.value}"`);
  const meta = [`frame: ${n.frame}`];
  if (n.region) meta.push(`region: ${n.region}`);
  if (n.anchors.length > 0) meta.push(`anchors: ${n.anchors.join(", ")}`);
  return `${parts.join(" ")}  (${meta.join("; ")})`;
};

export function buildMessages(req: DecisionRequest): { system: string; user: string } {
  const inputs = Object.entries(req.inputs)
    .map(([k, v]) => `  ${k} = ${v}`)
    .join("\n");

  const history =
    req.history.length === 0
      ? "  (nothing yet)"
      : req.history
          .slice(-8) // compact summary, never a full transcript
          .map((h) => `  ${h.step}. ${h.action} - ${h.rationale}${h.note ? ` [${h.note}]` : ""}`)
          .join("\n");

  const user = `GOAL
  ${req.goal}

AVAILABLE INPUTS (reference these by name; do not retype their values)
${inputs || "  (none)"}

WHAT YOU HAVE DONE SO FAR
${history}

CURRENT SCREEN${req.screenTitle ? `: ${req.screenTitle}` : ""}
${req.nodes.map(renderNode).join("\n")}

PERMITTED ACTION KINDS: ${req.allowedActions.join(", ")}

Reply with one JSON object.`;

  return { system: SYSTEM_PROMPT, user };
}

const KEY_NAMES = ["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp"];

/**
 * Total: anything unparseable becomes "stuck" rather than throwing. A malformed model
 * reply is a reason to involve a human, not a reason to crash the run.
 */
export function parseDecision(raw: string, validRefs: ReadonlySet<string>): AgentDecision {
  let text = raw.trim();

  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence?.[1]) text = fence[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return { kind: "stuck", reason: `model reply contained no JSON object: ${text.slice(0, 120)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return { kind: "stuck", reason: `model reply was not valid JSON: ${String(err)}` };
  }

  const o = parsed as Record<string, unknown>;
  const kind = o["kind"];

  if (kind === "done") {
    return { kind: "done", summary: String(o["summary"] ?? "goal reported complete") };
  }
  if (kind === "stuck") {
    return { kind: "stuck", reason: String(o["reason"] ?? "model reported it was stuck") };
  }

  const ref = String(o["ref"] ?? "");
  if (!validRefs.has(ref)) {
    return {
      kind: "stuck",
      reason: `model referenced "${ref}", which is not a control on the current screen`,
    };
  }

  if (kind === "extract") {
    const field = String(o["field"] ?? "").trim();
    if (!field) return { kind: "stuck", reason: "extract decision named no field" };
    return {
      kind: "extract",
      ref: asRef(ref),
      field,
      as: o["as"] === "number" ? "number" : "string",
      rationale: String(o["rationale"] ?? ""),
    };
  }

  if (kind !== "act") {
    return { kind: "stuck", reason: `unrecognised decision kind: ${String(kind)}` };
  }

  const action = (o["action"] ?? {}) as Record<string, unknown>;
  const rationale = String(o["rationale"] ?? "");

  switch (action["kind"]) {
    case "click":
      return { kind: "act", ref: asRef(ref), action: { kind: "click" }, rationale };
    case "dismiss":
      return { kind: "act", ref: asRef(ref), action: { kind: "dismiss" }, rationale };
    case "fill":
    case "select": {
      const inputName = String(action["inputName"] ?? "").trim();
      if (!inputName) {
        return { kind: "stuck", reason: `${String(action["kind"])} decision named no input` };
      }
      return {
        kind: "act",
        ref: asRef(ref),
        action: action["kind"] === "fill" ? { kind: "fill", inputName } : { kind: "select", inputName },
        rationale,
      };
    }
    case "pressKey": {
      const key = String(action["key"] ?? "Enter");
      if (!KEY_NAMES.includes(key)) {
        return { kind: "stuck", reason: `unsupported key: ${key}` };
      }
      return {
        kind: "act",
        ref: asRef(ref),
        action: { kind: "pressKey", key: key as "Enter" },
        rationale,
      };
    }
    default:
      return { kind: "stuck", reason: `unrecognised action kind: ${String(action["kind"])}` };
  }
}
