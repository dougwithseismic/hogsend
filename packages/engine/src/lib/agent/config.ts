import type { HogsendClient } from "../../container.js";

/**
 * Resolved availability of the Studio co-working agent. FAIL-CLOSED on the key:
 * the route family is only "enabled" when the master switch is on AND an
 * OpenRouter key is present, so the browser-facing `/config` probe reports
 * `enabled:false` (and `/chat` 503s) until the operator sets the secret —
 * the key itself never leaves the server.
 */
export interface AgentConfig {
  enabled: boolean;
  model: string;
}

export function agentConfig(env: HogsendClient["env"]): AgentConfig {
  const enabled =
    env.AGENT_ENABLED === "true" && Boolean(env.OPENROUTER_API_KEY);
  return { enabled, model: env.AGENT_MODEL };
}
