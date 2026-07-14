import { defineEmailProvider } from "@hogsend/core";

/**
 * The inert email provider a container boots with when NO provider is
 * configured and none was explicitly requested (mirrors the SMS channel's
 * operator-opt-in posture: unconfigured ⇒ inert stub, not a boot crash).
 *
 * A fresh scaffold has no RESEND_API_KEY yet — it should still boot, serve
 * Studio, ingest events and run non-email journeys. Every email send fails
 * per-call with this actionable message instead; the container logs one boot
 * warning. Never registered in the provider registry, so no webhook route
 * resolves it.
 */
export const UNCONFIGURED_EMAIL_MESSAGE =
  "no email provider configured — set RESEND_API_KEY (or POSTMARK_SERVER_TOKEN " +
  "with EMAIL_PROVIDER=postmark), or pass `email: { provider }` to " +
  "createHogsendClient().";

export function createUnconfiguredEmailProvider() {
  return defineEmailProvider({
    meta: {
      id: "unconfigured",
      name: "No email provider configured",
    },
    capabilities: {},
    async send() {
      throw new Error(UNCONFIGURED_EMAIL_MESSAGE);
    },
    async sendBatch() {
      throw new Error(UNCONFIGURED_EMAIL_MESSAGE);
    },
    verifyWebhook() {
      throw new Error(UNCONFIGURED_EMAIL_MESSAGE);
    },
    parseWebhook() {
      throw new Error(UNCONFIGURED_EMAIL_MESSAGE);
    },
  });
}
