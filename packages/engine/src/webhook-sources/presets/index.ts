import type { env as engineEnv } from "../../env.js";
import type { DefinedWebhookSource } from "../define-webhook-source.js";
import { clerkSource } from "./clerk.js";
import { intercomSource } from "./intercom.js";
import { segmentSource } from "./segment.js";
import { stripeSource } from "./stripe.js";
import { supabaseSource } from "./supabase.js";

export { clerkSource } from "./clerk.js";
export { intercomSource } from "./intercom.js";
export { segmentSource } from "./segment.js";
export { stripeSource } from "./stripe.js";
export { supabaseSource } from "./supabase.js";

/**
 * All shipped integration presets, keyed by their webhook-source id. The id is
 * also the route segment: `PRESET_SOURCES.stripe` serves `POST /v1/webhooks/stripe`.
 */
export const PRESET_SOURCES = {
  clerk: clerkSource,
  supabase: supabaseSource,
  stripe: stripeSource,
  segment: segmentSource,
  intercom: intercomSource,
} satisfies Record<string, DefinedWebhookSource>;

/** The stable id of a shipped preset (`"clerk" | "supabase" | "stripe" | "segment" | "intercom"`). */
export type PresetId = keyof typeof PRESET_SOURCES;

/** The slice of the validated env `presetsFromEnv` reads (preset secrets + override). */
type PresetEnv = Pick<
  typeof engineEnv,
  | "CLERK_WEBHOOK_SECRET"
  | "SUPABASE_WEBHOOK_SECRET"
  | "STRIPE_WEBHOOK_SECRET"
  | "SEGMENT_WEBHOOK_SECRET"
  | "INTERCOM_CLIENT_SECRET"
  | "ENABLED_WEBHOOK_PRESETS"
>;

/**
 * Resolve which presets to enable from the validated env (decision #13).
 *
 * Resolution order:
 *  1. `ENABLED_WEBHOOK_PRESETS === "none"` → no presets (hard off).
 *  2. `ENABLED_WEBHOOK_PRESETS` is a csv of ids → exactly those, but ONLY when
 *     the preset's secret (`env[auth.envKey]`) is also set (a signature source
 *     with no secret fails closed at runtime, so enabling it is pointless).
 *  3. `ENABLED_WEBHOOK_PRESETS === "*"` or absent → AUTO: every preset whose
 *     secret is present.
 *
 * In every branch a preset is only returned when its secret is configured, so a
 * preset can never be mounted in an always-fail-closed state by accident.
 */
export function presetsFromEnv(env: PresetEnv): DefinedWebhookSource[] {
  const override = env.ENABLED_WEBHOOK_PRESETS?.trim();

  if (override === "none") {
    return [];
  }

  const hasSecret = (source: DefinedWebhookSource): boolean => {
    const secret = env[source.auth.envKey as keyof PresetEnv];
    return typeof secret === "string" && secret.length > 0;
  };

  // Explicit csv allow-list (anything other than "*"/empty).
  if (override && override !== "*") {
    const ids = new Set(
      override
        .split(",")
        .map((id) => id.trim().toLowerCase())
        .filter((id) => id.length > 0),
    );
    return (
      Object.entries(PRESET_SOURCES) as [PresetId, DefinedWebhookSource][]
    )
      .filter(([id, source]) => ids.has(id) && hasSecret(source))
      .map(([, source]) => source);
  }

  // AUTO ("*" or absent): every preset whose secret is set.
  return Object.values(PRESET_SOURCES).filter(hasSecret);
}
