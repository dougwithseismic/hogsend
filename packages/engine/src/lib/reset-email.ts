import { getEmailService } from "./email.js";
import type { EmailService } from "./email-service-types.js";
import { createLogger, type Logger } from "./logger.js";

// Fallback logger for the no-provider warning — callers may not pass one. Mirrors
// the engine-lib singleton pattern (mailer, define-journey, tracked).
const fallbackLogger = createLogger(process.env.LOG_LEVEL);

/**
 * The TTL the reset link advertises in its copy. Mirrors the
 * `resetPasswordTokenExpiresIn` we configure in `createAuth` (15 minutes) so the
 * email never claims a window that doesn't match the server's enforcement.
 */
const RESET_TTL_MINUTES = 15;

/**
 * The engine-owned, self-contained password-reset email. The engine ships NO
 * business templates (those live in the consumer's `src/emails/`), so a reset
 * email that required a consumer template would break the "works out of the box"
 * guarantee. This builds a tiny inline HTML + plaintext body — no React Email
 * dependency, no template-registry lookup — and sends it through the resolved
 * provider via the mailer's RAW path.
 *
 * `sendRaw` is correct here (not `send`): a password reset is strictly
 * transactional and must bypass template resolution AND the
 * preference/suppression check — a recovering operator must always receive it,
 * marketing opt-out or not. There is no tracking pixel and no unsubscribe footer
 * for the same reason.
 *
 * Security:
 * - NEVER logs the `url` or the token. On a delivery failure we log a generic
 *   warning (pointing the operator at the CLI) and RESOLVE without throwing, so
 *   better-auth's neutral "if this email exists…" response is preserved (no user
 *   enumeration, no leak of whether the address was real).
 * - The `from` resolves from `EMAIL_FROM ?? RESEND_FROM_EMAIL` — but we don't
 *   pass it explicitly: the mailer's `sendRaw` defaults `from` to its configured
 *   `defaultFrom`, which is exactly that pair.
 */
export async function sendResetPasswordEmail(opts: {
  to: string;
  url: string;
  /**
   * The mailer to send through. Optional: defaults to the container-installed
   * singleton (`getEmailService()`). Injectable so tests can pass a spy and
   * assert the send fires without touching a real provider.
   */
  emailService?: EmailService;
  /** Optional structured logger; defaults to a stdout logger. */
  logger?: Logger;
}): Promise<void> {
  const { to, url } = opts;
  const log = opts.logger ?? fallbackLogger;

  let service: EmailService;
  try {
    service = opts.emailService ?? getEmailService();
  } catch {
    // The mailer singleton hasn't been installed (container never booted). Steer
    // the operator to the guaranteed recovery path; never throw (preserves the
    // neutral response). Do NOT log the url/token.
    log.warn(
      "password reset requested but no email service is configured — use `hogsend studio admin reset`",
    );
    return;
  }

  const subject = "Reset your Hogsend Studio password";
  const html = buildResetHtml(url);
  const text = buildResetText(url);

  try {
    await service.sendRaw({ to, subject, html, text });
  } catch (error) {
    // A provider error (missing/invalid key, network) must not surface to the
    // caller — better-auth's neutral response stays intact. Log a generic
    // warning that points at the CLI fallback. NEVER include the url/token.
    log.warn(
      "password reset email failed to send (no usable email provider?) — use `hogsend studio admin reset`",
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
}

/** Minimal, dependency-free HTML body. The URL appears as a button and a raw
 * link (so it works even when buttons are stripped). No tracking, no footer. */
function buildResetHtml(url: string): string {
  const safeUrl = escapeHtmlAttr(url);
  const safeText = escapeHtml(url);
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px;">
      <tr><td>
        <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;">Reset your password</h1>
        <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#3f3f46;">
          We received a request to reset your Hogsend Studio password. Click the
          button below to choose a new one.
        </p>
        <p style="margin:0 0 24px;">
          <a href="${safeUrl}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:6px;">Reset password</a>
        </p>
        <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#71717a;">
          Or paste this link into your browser:<br />
          <a href="${safeUrl}" style="color:#2563eb;word-break:break-all;">${safeText}</a>
        </p>
        <p style="margin:0;font-size:12px;line-height:1.6;color:#a1a1aa;">
          This link expires in ${RESET_TTL_MINUTES} minutes and can be used once.
          If you didn't request a password reset, you can safely ignore this email.
        </p>
      </td></tr>
    </table>
  </body>
</html>`;
}

/** Plain-text alternative (same content, no markup). */
function buildResetText(url: string): string {
  return [
    "Reset your password",
    "",
    "We received a request to reset your Hogsend Studio password.",
    "Open this link to choose a new one:",
    "",
    url,
    "",
    `This link expires in ${RESET_TTL_MINUTES} minutes and can be used once.`,
    "If you didn't request a password reset, you can safely ignore this email.",
  ].join("\n");
}

/** Escape for an HTML text node. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape for a double-quoted HTML attribute (e.g. an `href`). */
function escapeHtmlAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
