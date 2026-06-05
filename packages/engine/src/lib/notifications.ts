import { getEmailService } from "./email.js";

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

export async function sendEmailNotification(opts: {
  to: string;
  subject: string;
  body: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    // Route through the injected EmailProvider (via the mailer's `sendRaw`)
    // instead of constructing a raw Resend client from process.env. The
    // alerting task runs under the worker, where createHogsendClient has already
    // installed the email service.
    await getEmailService().sendRaw({
      from: "Hogsend Alerts <alerts@hogsend.com>",
      to: opts.to,
      subject: opts.subject,
      html: opts.body,
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
