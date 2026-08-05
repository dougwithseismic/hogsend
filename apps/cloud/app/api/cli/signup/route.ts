import { z } from "zod";
import { auth, OTP_EXPIRES_IN_SECONDS } from "@/src/lib/auth";
import { clientIp, consumeDualRateLimit } from "@/src/lib/rate-limit";
import { fail } from "@/src/lib/route-response";

/**
 * `POST /api/cli/signup` — the front door for `hogsend signup`, and the same
 * one `hogsend login --email` uses.
 *
 * It mails an OTP. That is the whole endpoint: "email is correct" IS the auth
 * here, exactly as in the browser, and the code is the proof of inbox
 * ownership. There is no password anywhere in this flow.
 *
 * TWO decisions worth stating, because both are load-bearing:
 *
 *  1. **The OTP is Better Auth's, not a parallel table.** The `emailOTP`
 *     plugin's `"sign-in"` type does precisely what this PRD asks for and
 *     nothing else has to be built: it mails a code for a NEW address as
 *     readily as a registered one (`disableSignUp` is off), and its verify
 *     leg creates the user with `emailVerified: true` when there is none. A
 *     `cli_otp` table mirroring `cli_device_codes` was the fallback if the
 *     plugin could not be driven headless — it can, through `auth.api`, so
 *     the fallback is not built. One OTP implementation, one expiry, one
 *     attempt budget, shared with the browser.
 *  2. **The answer is IDENTICAL for a new and an existing email.** 200
 *     `{ status: "sent" }` either way, with no field that varies. An endpoint
 *     that said "welcome back" would be an account-existence oracle for
 *     anybody with a list of addresses, and it is unauthenticated by
 *     necessity. The CLI does not need to know either: verify tells it what
 *     happened, once the human has proven they hold the inbox.
 *
 * Rate limited on BOTH axes, because they stop different attacks: per EMAIL so
 * one address cannot be mail-bombed from a botnet, and per IP so one caller
 * cannot walk a list of addresses. Both count refusals (see
 * `consumeRateLimit`), and the per-IP address is read right-anchored from
 * `x-forwarded-for` under `CLOUD_TRUSTED_PROXY_HOPS` — a header-rotating
 * caller gets no fresh budget.
 */

/** Three codes per address per ten minutes. A human needs one, maybe two. */
export const SIGNUP_EMAIL_RATE_LIMIT = 3;

/**
 * Ten per address per ten minutes. Above a shared office NAT's honest traffic
 * and far below what walking a list of addresses would need.
 */
export const SIGNUP_IP_RATE_LIMIT = 10;

export const SIGNUP_RATE_WINDOW_MS = 10 * 60_000;

const bodySchema = z.object({
  email: z.email().max(254),
});

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let email: string;
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return fail(
        400,
        "invalid_email",
        "Send `{ email }` as JSON, carrying a valid email address.",
      );
    }
    // Lowercased HERE as well as inside Better Auth, because the rate-limit
    // bucket is ours: `Alice@x.com` and `alice@x.com` are one inbox and must
    // not be two budgets.
    email = parsed.data.email.toLowerCase();
  } catch {
    return fail(400, "invalid_request", "The request body must be JSON.");
  }

  const limit = await consumeDualRateLimit({
    email,
    ip: clientIp(request.headers),
    emailLimit: SIGNUP_EMAIL_RATE_LIMIT,
    ipLimit: SIGNUP_IP_RATE_LIMIT,
    windowMs: SIGNUP_RATE_WINDOW_MS,
    prefix: "cli_signup",
  });
  if (!limit.allowed) {
    return fail(
      429,
      "rate_limited",
      "Too many codes requested. Wait for the retry-after window and try again.",
      { "retry-after": String(limit.retryAfterSeconds) },
    );
  }

  try {
    await auth.api.sendVerificationOTP({
      // `sign-in`, not `email-verification`: it is the one type whose send leg
      // mails an unknown address (rather than silently discarding the code)
      // and whose verify leg may create the user. That pair IS the
      // signup-or-login flow this endpoint promises.
      body: { email, type: "sign-in" },
    });
  } catch (error) {
    // Never leaked to the caller: the answer must not vary with what happened
    // to a particular address, and the operator's copy is the log.
    console.error("[cloud] CLI signup could not send an OTP:", error);
    return fail(
      502,
      "send_failed",
      "The verification code could not be sent. Try again shortly.",
    );
  }

  return Response.json(
    {
      status: "sent",
      // What the CLI prints, so it does not have to hard-code our expiry.
      expiresInSeconds: OTP_EXPIRES_IN_SECONDS,
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
