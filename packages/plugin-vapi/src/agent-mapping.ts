import type { VoiceAgentConfig } from "./types.js";

/**
 * Translate the provider-neutral {@link VoiceAgentConfig} the engine synthesizes
 * into a Vapi **transient assistant** object (an inline assistant sent on the
 * create-call request — no pre-created assistantId needed). This is the ONLY
 * place Vapi's assistant shape leaks; everything upstream is provider-neutral.
 *
 * Maps:
 * - `systemPrompt` → `model.messages[0]` (role "system").
 * - `model` → `model.provider/model/temperature` (defaults to OpenAI gpt-4o).
 * - `voice` → `voice.provider/voiceId` (defaults to a Vapi-hosted voice).
 * - `tools` → `model.tools[]` as `{ type: "function", function: {...} }`.
 * - `dataSchema` → `analysisPlan.structuredDataPlan` (post-call extraction).
 * - `endCallPhrases` / `maxDurationSec` → their Vapi equivalents.
 * - `server` (when configured) → the assistant's server URL + secret, so
 *   status/end-of-call/tool-call webhooks route back to the engine.
 */
export function toVapiAssistant(
  config: VoiceAgentConfig,
  server?: { url: string; secret?: string },
): Record<string, unknown> {
  // Default to the latest fast Claude that VAPI ACCEPTS. Vapi validates
  // `model.model` against its own allow-list (which lags Anthropic's absolute
  // latest — `claude-sonnet-5` is rejected with a 400 today), so the default is
  // `claude-sonnet-4-6`: the newest fast, NON-reasoning Sonnet on Vapi's list.
  // For VOICE the model MUST be non-reasoning (a thinking model's TTFT explodes
  // into audible pauses). Fully overridable per agent — Vapi is provider-agnostic
  // (OpenAI / Anthropic / Google / Groq / custom); `claude-haiku-4-5-20251001`
  // is the lowest-latency option.
  const model: Record<string, unknown> = {
    provider: config.model?.provider ?? "anthropic",
    model: config.model?.model ?? "claude-sonnet-4-6",
    messages: [{ role: "system", content: config.systemPrompt }],
  };
  if (config.model?.temperature !== undefined) {
    model.temperature = config.model.temperature;
  }
  if (config.tools?.length) {
    model.tools = config.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.parameters,
      },
    }));
  }

  const assistant: Record<string, unknown> = { model };

  if (config.firstMessage) assistant.firstMessage = config.firstMessage;
  if (config.voice?.provider || config.voice?.voiceId) {
    assistant.voice = {
      ...(config.voice.provider ? { provider: config.voice.provider } : {}),
      ...(config.voice.voiceId ? { voiceId: config.voice.voiceId } : {}),
    };
  }
  if (config.endCallPhrases?.length) {
    assistant.endCallPhrases = config.endCallPhrases;
  }
  if (config.maxDurationSec !== undefined) {
    assistant.maxDurationSeconds = config.maxDurationSec;
  }
  if (config.dataSchema) {
    assistant.analysisPlan = {
      structuredDataPlan: { enabled: true, schema: config.dataSchema },
    };
  }
  // Vapi records by default (artifactPlan.recordingEnabled: true) — a two-party-
  // consent hazard. Force it OFF unless the agent explicitly opts in, so a call
  // is only recorded when the operator asked for it (and disclosed it).
  assistant.artifactPlan = { recordingEnabled: config.record === true };
  if (server?.url) {
    assistant.server = {
      url: server.url,
      ...(server.secret ? { secret: server.secret } : {}),
    };
  }

  return assistant;
}
