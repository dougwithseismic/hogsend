import type { VoiceAgentConfig } from "@hogsend/core";
import { getVoiceAgentDefinition } from "./registry.js";
import type {
  VoiceAgentName,
  VoiceAgentRegistry,
  VoiceAgentRegistryMap,
  VoiceAgentRenderResult,
} from "./types.js";

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Replace `{{variable}}` placeholders in `text` with the matching value from
 * `variables`. An unmatched placeholder is left VERBATIM (never blanked) — many
 * providers do their own server-side interpolation from the same variable bag,
 * so a placeholder the engine can't fill may still be filled downstream. Values
 * are coerced to strings; whitespace inside the braces is tolerated.
 */
export function interpolate(
  text: string,
  variables: Record<string, string | number | boolean> = {},
): string {
  return text.replace(PLACEHOLDER, (match, name: string) =>
    Object.hasOwn(variables, name) ? String(variables[name]) : match,
  );
}

function interpolateConfig(
  config: VoiceAgentConfig,
  variables: Record<string, string | number | boolean>,
): VoiceAgentConfig {
  return {
    ...config,
    systemPrompt: interpolate(config.systemPrompt, variables),
    firstMessage: config.firstMessage
      ? interpolate(config.firstMessage, variables)
      : config.firstMessage,
    endCallPhrases: config.endCallPhrases?.map((p) =>
      interpolate(p, variables),
    ),
  };
}

/**
 * Resolve a registered voice agent to a provider-ready {@link VoiceAgentConfig}:
 * run its `build(props)` then interpolate `{{variable}}` placeholders in the
 * prompt fields. The voice analogue of `renderSmsToText` — but it produces an
 * agent config, not a wire string.
 */
export function renderVoiceAgent<K extends VoiceAgentName>(opts: {
  key: K;
  props: VoiceAgentRegistryMap[K];
  registry: VoiceAgentRegistry;
  variables?: Record<string, string | number | boolean>;
}): VoiceAgentRenderResult {
  const { key, props, registry, variables = {} } = opts;
  const definition = getVoiceAgentDefinition({ key, registry });
  const built = definition.build(props);
  return {
    config: interpolateConfig(built, variables),
    category: definition.category,
  };
}
