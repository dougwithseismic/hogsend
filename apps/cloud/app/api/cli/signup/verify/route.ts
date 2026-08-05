import { z } from "zod";
import { completeCliSignup } from "@/src/lib/cli-signup";
import { clientIp, consumeDualRateLimit } from "@/src/lib/rate-limit";
import { fail } from "@/src/lib/route-response";

/**
 * `POST /api/cli/signup/verify` — the code comes back, and the machine is
 * logged in.
 *
 * ONE round trip does everything the browser flow spreads over several screens:
 * the OTP is verified, the user is created if this address has never been seen,
 * an organization + production environment + stack row is minted if they belong
 * to none, and a `hscli_…` session token is returned. That token is the ONLY
 * copy that will ever exist outside the machine receiving it — see
 * `services/cli-sessions.ts`.
 *
 * The refusals are deliberately distinct where the CLI can act on them and
 * deliberately identical where telling them apart would leak:
 *
 *  - `invalid_code` / `code_expired` / `code_burned` are three different things
 *    a human must do next (retype it, ask for a new one, ask for a new one and
 *    stop guessing), and none of them says anything about whether the address
 *    is registered — Better Auth verifies the code before it ever looks the
 *    user up, so a wrong code for a stranger's address and for your own answer
 *    the same way;
 *  - the attempt budget is the plugin's (three tries, then the code is burned),
 *    shared with the browser, so there is one number rather than two;
 *  - the rate limit here is per email AND per IP, like the send leg: this is
 *    where guesses are spent, so the ceiling on guesses-per-window is what
 *    stands between a six-digit code and a script.
 */

/**
 * Ten verifies per address per ten minutes. Well above the plugin's own
 * three-attempt budget per code (so an honest human who requested a second
 * code is never refused here), and a hard ceiling on the number of codes a
 * script can burn through for one address in a window.
 */
export const VERIFY_EMAIL_RATE_LIMIT = 10;

/** Thirty per address per ten minutes — several machines behind one NAT. */
export const VERIFY_IP_RATE_LIMIT = 30;

export const VERIFY_RATE_WINDOW_MS = 10 * 60_000;

const bodySchema = z.object({
  email: z.email().max(254),
  // Bounded before it is spent: an unbounded body must not become work.
  otp: z.string().trim().min(1).max(32),
  /** Optional organization NAME. Honoured only when the user has none. */
  org: z.string().trim().min(1).max(200).optional(),
  region: z.enum(["us", "eu"]).optional(),
  /** A hostname, as with the device flow. A label is not a payload. */
  label: z.string().trim().min(1).max(128).optional(),
});

export const dynamic = "force-dynamic";

/** The one sentence each refusal turns into. */
const REFUSALS = {
  invalid_code: {
    status: 401,
    message: "That code is not right. Check it and try again.",
  },
  code_expired: {
    status: 401,
    message: "That code has expired. Run the signup again for a fresh one.",
  },
  code_burned: {
    status: 401,
    message:
      "Too many wrong attempts — that code is dead. Run the signup again for a fresh one.",
  },
  no_region: {
    status: 503,
    message:
      "No capacity is available in that region right now. Contact us and we will place you.",
  },
} as const;

export async function POST(request: Request): Promise<Response> {
  let body: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return fail(
        400,
        "invalid_request",
        "Send `{ email, otp }` as JSON, optionally with `org`, `region` and `label`.",
      );
    }
    body = parsed.data;
  } catch {
    return fail(400, "invalid_request", "The request body must be JSON.");
  }

  const email = body.email.toLowerCase();
  const limit = await consumeDualRateLimit({
    email,
    ip: clientIp(request.headers),
    emailLimit: VERIFY_EMAIL_RATE_LIMIT,
    ipLimit: VERIFY_IP_RATE_LIMIT,
    windowMs: VERIFY_RATE_WINDOW_MS,
    prefix: "cli_verify",
  });
  if (!limit.allowed) {
    return fail(
      429,
      "rate_limited",
      "Too many attempts. Wait for the retry-after window and try again.",
      { "retry-after": String(limit.retryAfterSeconds) },
    );
  }

  const result = await completeCliSignup({
    email,
    otp: body.otp,
    ...(body.org === undefined ? {} : { org: body.org }),
    ...(body.region === undefined ? {} : { region: body.region }),
    ...(body.label === undefined ? {} : { label: body.label }),
  });

  if (!result.ok) {
    const refusal = REFUSALS[result.refusal];
    return fail(refusal.status, result.refusal, refusal.message);
  }

  return Response.json(
    {
      status: "ok",
      created: result.created,
      // The ONLY copy of this token that will ever exist outside the machine
      // that receives it.
      token: result.token,
      sessionId: result.sessionId,
      userId: result.userId,
      organizationId: result.organizationId,
      environmentId: result.environmentId,
      // Present only when an `--org` was ignored because the user already had
      // one. The CLI prints it; nothing depends on it.
      note: result.note,
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
