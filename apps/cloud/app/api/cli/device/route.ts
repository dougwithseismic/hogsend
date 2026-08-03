import { z } from "zod";
import { DEFAULT_CLOUD_PUBLIC_URL, env } from "@/src/env";
import { clientIp, consumeRateLimit } from "@/src/lib/rate-limit";
import {
  cliDeviceCodeService,
  DEVICE_CODE_TTL_MS,
} from "@/src/services/cli-device-codes";

/**
 * `POST /api/cli/device` — `hogsend login` opens a login attempt here.
 *
 * UNAUTHENTICATED by necessity: the whole point of a device flow is that the
 * machine asking has no credential yet. So the only thing standing between this
 * endpoint and an attacker enumerating user codes is the rate limit below and
 * the fact that a user code approves NOTHING on its own — approval is a
 * mutation performed by a signed-in dashboard user, and the code merely names
 * which pending request they are approving.
 *
 * The response carries the device code (a 256-bit secret the CLI polls with)
 * and the user code (short, read-aloud safe). Nothing here is stored in the
 * clear: `cli_device_codes` holds the sha256 of the device code.
 *
 * What it deliberately does NOT carry is a verification URL with the user code
 * already in it. RFC 8628 §3.3.1 makes `verification_uri_complete` optional and
 * §5.4 says why: a link that prefills the code turns a stranger's pending login
 * into one click for whoever opens it, and the human transcribing the code is
 * the ONLY thing binding the browser that approves to the machine that asked.
 * The label below is attacker-chosen (this endpoint is unauthenticated), so it
 * can never be that binding. The CLI prints the code and the bare URL; the
 * ONLY prefilled link that exists is the one the CLI builds locally for the
 * same machine's own browser, which no stranger ever holds.
 */

/** The path the dashboard serves the approve page from. */
export const CLI_APPROVE_PATH = "/cli/approve";

/**
 * Ten login attempts per minute per address. Generous for a human at a
 * terminal (a retry, a second machine, a shared office NAT) and far below what
 * enumerating a 30^8 code space would need — which is the point: the limit is
 * here so the CODE SPACE is never the only defence, not because minting is
 * expensive.
 */
export const DEVICE_MINT_RATE_LIMIT = 10;
export const DEVICE_MINT_RATE_WINDOW_MS = 60_000;

/** A label is a hostname, not a payload. */
const bodySchema = z.object({
  label: z.string().trim().min(1).max(128).optional(),
});

export const dynamic = "force-dynamic";

function fail(
  status: number,
  error: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error, message },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const limit = await consumeRateLimit({
    bucket: `cli_device_mint:${clientIp(request.headers)}`,
    limit: DEVICE_MINT_RATE_LIMIT,
    windowMs: DEVICE_MINT_RATE_WINDOW_MS,
  });
  if (!limit.allowed) {
    return fail(
      429,
      "rate_limited",
      "Too many login attempts from this address. Try again shortly.",
      { "retry-after": String(limit.retryAfterSeconds) },
    );
  }

  // A body is optional: `hogsend login` sends a hostname, anything else may
  // send nothing at all.
  let label: string | undefined;
  try {
    const raw = await request.text();
    if (raw.trim().length > 0) {
      const parsed = bodySchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        return fail(
          400,
          "invalid_request",
          "`label` must be a string of at most 128 characters.",
        );
      }
      label = parsed.data.label;
    }
  } catch {
    return fail(400, "invalid_request", "The request body must be JSON.");
  }

  // Exactly once per address per window — the request that OPENED the bucket —
  // clear the codes that lapsed a day ago. `cli_device_codes` grows only from
  // this endpoint, so pruning here is pruning exactly when it is needed, and
  // never on an idle control plane. A failed reap must not fail a login.
  if (limit.count === 1) {
    await cliDeviceCodeService
      .reap()
      .catch((error) =>
        console.error("[cloud] CLI device-code reap failed:", error),
      );
  }

  const minted = await cliDeviceCodeService.mint(
    label === undefined ? {} : { label },
  );

  const base = (env.CLOUD_PUBLIC_URL ?? DEFAULT_CLOUD_PUBLIC_URL).replace(
    /\/+$/,
    "",
  );

  return Response.json(
    {
      deviceCode: minted.deviceCode,
      userCode: minted.userCode,
      // Bare, never prefilled — see the module note. The CLI opens this and
      // prints `userCode` for the human to type.
      verificationUrl: `${base}${CLI_APPROVE_PATH}`,
      expiresIn: Math.floor(DEVICE_CODE_TTL_MS / 1000),
      interval: minted.interval,
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
