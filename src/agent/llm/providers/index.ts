import type { LlmClient } from "../llm-client.js";
import { GroqClient } from "./groq.js";

const DEFAULT_MODELS: Record<string, string> = {
  groq: "llama-3.3-70b-versatile",
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o",
};

/**
 * Provider and model selection is configuration, not code. Adding a provider means
 * adding one adapter here; nothing above this file changes.
 *
 * Only the Groq adapter is implemented. Anthropic and OpenAI are left as explicit,
 * named extension points rather than padded stubs: an adapter that has never run against
 * its provider proves nothing, and pretending otherwise would be worse than saying so.
 */
export function createLlmClient(env: NodeJS.ProcessEnv = process.env): LlmClient {
  const provider = (env["LLM_PROVIDER"] ?? "groq").toLowerCase();
  const model = env["LLM_MODEL"] ?? DEFAULT_MODELS[provider];

  if (!model) {
    throw new Error(`no default model for provider "${provider}" - set LLM_MODEL`);
  }

  switch (provider) {
    case "groq": {
      const apiKey = env["GROQ_API_KEY"];
      if (!apiKey) {
        throw new Error("GROQ_API_KEY is not set - copy .env.example to .env and fill it in");
      }
      return new GroqClient(model, apiKey);
    }

    case "anthropic":
    case "openai":
      throw new Error(
        `provider "${provider}" is a documented extension point, not an implemented adapter. ` +
          `Implement src/agent/llm/providers/${provider}.ts against the LlmClient interface ` +
          `(one decide() method: format messages, call the API, hand the reply to ` +
          `parseDecision). Nothing outside that file needs to change.`,
      );

    default:
      throw new Error(
        `unknown LLM_PROVIDER "${provider}". Supported: groq (implemented), ` +
          `anthropic and openai (extension points).`,
      );
  }
}
