import { Resend } from "resend";

const FALLBACK_FROM = "Hogsend Courses <courses@hogsend.com>";

/**
 * Send the Better Auth magic-link directly via Resend (NOT through the dogfood
 * engine mailer — that rewrites every href through the click tracker, which
 * would corrupt the single-use token URL, and its suppression list could deny an
 * unsubscribed contact a sign-in link). Soft-skips when RESEND_API_KEY is unset
 * (local dev / build). NEVER logs the url or token.
 */
export async function sendMagicLinkEmail(
  to: string,
  url: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      "[course-auth] RESEND_API_KEY unset — magic-link email not sent",
    );
    return;
  }
  const from = process.env.COURSE_FROM_EMAIL ?? FALLBACK_FROM;
  const resend = new Resend(apiKey);

  await resend.emails.send({
    from,
    to,
    subject: "Your Hogsend Courses sign-in link",
    html: magicLinkHtml(url),
  });
}

/**
 * Send a passwordless sign-in CODE (email OTP) via Resend. Same Resend-direct
 * path as the magic link — the engine mailer is bypassed so the code is never
 * rewritten by the click tracker and an unsubscribed contact is never denied a
 * sign-in code. Soft-skips when RESEND_API_KEY is unset. NEVER logs the code.
 */
export async function sendOtpEmail(to: string, otp: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[course-auth] RESEND_API_KEY unset — sign-in code not sent");
    return;
  }
  const from = process.env.COURSE_FROM_EMAIL ?? FALLBACK_FROM;
  const resend = new Resend(apiKey);

  await resend.emails.send({
    from,
    to,
    subject: `${otp} is your Hogsend Courses sign-in code`,
    html: otpHtml(otp),
  });
}

/**
 * Send the Better Auth account-deletion confirmation link via Resend. Same
 * Resend-direct path as the magic link (no tracker rewrite of the single-use
 * token). Soft-skips when RESEND_API_KEY is unset. NEVER logs the url or token.
 */
export async function sendDeleteAccountEmail(
  to: string,
  url: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      "[course-auth] RESEND_API_KEY unset — delete-account email not sent",
    );
    return;
  }
  const from = process.env.COURSE_FROM_EMAIL ?? FALLBACK_FROM;
  const resend = new Resend(apiKey);

  await resend.emails.send({
    from,
    to,
    subject: "Confirm deleting your Hogsend Courses account",
    html: deleteAccountHtml(url),
  });
}

function deleteAccountHtml(url: string): string {
  return `<!doctype html><html><body style="margin:0;background:#050101;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px">
    <p style="font-size:18px;font-weight:600;margin:0 0 8px">Hogsend Courses</p>
    <p style="color:rgba(255,255,255,0.6);font-size:15px;line-height:22px;margin:0 0 24px">
      You asked to delete your account. This permanently removes your profile, course
      progress, and purchases from Hogsend Courses and cannot be undone. The link is
      single-use and expires shortly.
    </p>
    <a href="${url}" style="display:inline-block;background:#f64838;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:10px">Permanently delete my account</a>
    <p style="color:rgba(255,255,255,0.4);font-size:13px;line-height:20px;margin:28px 0 0">
      If you didn't request this, ignore this email and your account stays exactly as it is.
    </p>
  </div></body></html>`;
}

function otpHtml(otp: string): string {
  return `<!doctype html><html><body style="margin:0;background:#050101;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px">
    <p style="font-size:18px;font-weight:600;margin:0 0 8px">Hogsend Courses</p>
    <p style="color:rgba(255,255,255,0.6);font-size:15px;line-height:22px;margin:0 0 24px">
      Enter this code to sign in. It's single-use and expires in 15 minutes.
    </p>
    <div style="display:inline-block;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:16px 24px;font-size:34px;font-weight:700;letter-spacing:10px;line-height:1">${otp}</div>
    <p style="color:rgba(255,255,255,0.4);font-size:13px;line-height:20px;margin:28px 0 0">
      If you didn't request this, you can ignore this email.
    </p>
  </div></body></html>`;
}

function magicLinkHtml(url: string): string {
  return `<!doctype html><html><body style="margin:0;background:#050101;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px">
    <p style="font-size:18px;font-weight:600;margin:0 0 8px">Hogsend Courses</p>
    <p style="color:rgba(255,255,255,0.6);font-size:15px;line-height:22px;margin:0 0 24px">
      Click below to sign in. This link is single-use and expires in 15 minutes.
    </p>
    <a href="${url}" style="display:inline-block;background:#ffffff;color:#0a0a0a;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:10px">Sign in to Hogsend Courses</a>
    <p style="color:rgba(255,255,255,0.4);font-size:13px;line-height:20px;margin:28px 0 0">
      If you didn't request this, you can ignore this email.
    </p>
  </div></body></html>`;
}
