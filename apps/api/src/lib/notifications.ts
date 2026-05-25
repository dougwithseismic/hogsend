export async function sendWebhook(
  url: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return {
        ok: false,
        error: `HTTP ${res.status}: ${res.statusText}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function sendSlackNotification(
  webhookUrl: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  return sendWebhook(webhookUrl, { text });
}

import { createResendClient } from "@hogsend/plugin-resend";

export async function sendEmailNotification(opts: {
  to: string;
  subject: string;
  body: string;
  resendApiKey: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = createResendClient({ apiKey: opts.resendApiKey });
    const { error } = await client.emails.send({
      from: "Hogsend Alerts <alerts@hogsend.com>",
      to: opts.to,
      subject: opts.subject,
      html: opts.body,
    });
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
