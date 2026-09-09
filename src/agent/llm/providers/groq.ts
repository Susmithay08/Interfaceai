import Groq from "groq-sdk";
import type { AgentDecision, DecisionRequest, LlmClient } from "../llm-client.js";
import { buildMessages, parseDecision } from "../prompt.js";

/**
 * Groq adapter. Everything Groq-specific stops here: SDK construction, message shape,
 * JSON-mode configuration, and auth. The loop above sees only AgentDecision.
 */
export class GroqClient implements LlmClient {
  readonly provider = "groq";
  readonly #client: Groq;

  constructor(
    readonly model: string,
    apiKey: string,
  ) {
    this.#client = new Groq({ apiKey });
  }

  async decide(req: DecisionRequest): Promise<AgentDecision> {
    const { system, user } = buildMessages(req);

    const completion = await this.#client.chat.completions.create({
      model: this.model,
      // Temperature 0: discovery should be as reproducible as a sampling model allows.
      temperature: 0,
      max_tokens: 700,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const text = completion.choices[0]?.message?.content ?? "";
    return parseDecision(text, new Set(req.nodes.map((n) => String(n.ref))));
  }
}
