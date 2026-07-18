import type { env as engineEnv } from "../../env.js";
import {
  type DefinedWebhookSource,
  webhookSourceToConnector,
} from "../../webhook-sources/define-webhook-source.js";
import {
  PRESET_SOURCES,
  presetsFromEnv,
} from "../../webhook-sources/presets/index.js";
import type { DefinedConnector } from "../define-connector.js";

/**
 * Every shipped connector preset, keyed by id. Webhook-transport presets are
 * the existing `defineWebhookSource` presets lifted onto the umbrella; gateway/
 * poll presets (Discord) are SHIPPED IN THE PLUGIN, not here — the engine
 * bundles no Discord code.
 */
export const PRESET_CONNECTORS: Record<string, DefinedConnector> =
  Object.fromEntries(
    // The registry is heterogeneous (`satisfies Record<string,
    // DefinedWebhookSource>`); consume it at that declared type so a new preset
    // whose payload shape diverges can't break union-inference on the lift.
    (Object.values(PRESET_SOURCES) as DefinedWebhookSource[]).map((s) => [
      s.meta.id,
      webhookSourceToConnector(s),
    ]),
  );

/**
 * Resolve which connector presets to register from env. Webhook presets keep
 * their exact env-secret gating (delegated to `presetsFromEnv`). Gateway/poll
 * presets are consumer-supplied via `opts.connectors` (the Discord plugin), so
 * this preset resolver covers only the engine-shipped webhook presets.
 */
export function connectorsFromEnv(env: typeof engineEnv): DefinedConnector[] {
  return presetsFromEnv(env).map(webhookSourceToConnector);
}
