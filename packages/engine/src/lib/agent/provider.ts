import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { HogsendClient } from "../../container.js";

/**
 * The language model the agent runs on, built from env (OpenRouter + AGENT_MODEL,
 * default GLM-5.2). Throws when the key is absent — callers gate on
 * {@link agentConfig} first, so this only fires on a misconfiguration.
 */
export function getAgentModel(env: HogsendClient["env"]): LanguageModel {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY is not set — the agent is not configured",
    );
  }
  const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
  return openrouter(env.AGENT_MODEL);
}
