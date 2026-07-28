import { env } from "../env";

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text only — the control plane sends codes, not marketing. */
  text: string;
}

/**
 * The single seam between the control plane and "an email left the building".
 * Everything that needs to reach a human (today: the sign-up OTP) goes through
 * this, so swapping transports is one function and tests get a spy for free.
 */
export interface EmailSender {
  /** Stable id, logged at boot so the active transport is never a guess. */
  readonly id: string;
  send(message: EmailMessage): Promise<void>;
}

/**
 * DEV/TEST transport: writes the message to the server log and returns. This is
 * how a local signup is completed with no mail provider configured — the OTP is
 * read straight out of `next dev` output.
 *
 * Safe by construction: it cannot reach the network, so no test can send real
 * mail by accident.
 */
export const logSender: EmailSender = {
  id: "log",
  async send(message) {
    console.log(
      `[cloud:email:log] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`,
    );
  },
};

/**
 * Resend transport over the plain REST API — deliberately no `resend` SDK
 * dependency for one POST. The key is OUR key (`CLOUD_RESEND_API_KEY`), never a
 * tenant's; tenant provider keys live encrypted in `cloud.provider_keys` and are
 * used by the provisioner, not here.
 */
export function resendSender(apiKey: string, from: string): EmailSender {
  return {
    id: "resend",
    async send(message) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
      });
      if (!res.ok) {
        // The body can echo the recipient but never the key; the OTP is in
        // `message.text`, which is NOT logged here.
        throw new Error(
          `[cloud:email:resend] send failed (${res.status}): ${await res.text()}`,
        );
      }
    },
  };
}

/**
 * Pick the transport from the environment. Absence of a key is a supported
 * configuration (log transport), not an error — a fresh clone signs up without
 * touching a mail provider.
 */
export function resolveEmailSender(): EmailSender {
  const key = env.CLOUD_RESEND_API_KEY;
  if (!key) return logSender;
  return resendSender(key, env.CLOUD_RESEND_FROM);
}
