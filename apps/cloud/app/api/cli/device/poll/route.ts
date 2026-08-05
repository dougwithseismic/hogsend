import { z } from "zod";
import { clientIp, consumeRateLimit } from "@/src/lib/rate-limit";
import { fail } from "@/src/lib/route-response";
import { cliDeviceCodeService } from "@/src/services/cli-device-codes";

/**
 * `POST /api/cli/device/poll` — the waiting half of `hogsend login`.
 *
 * The device code is the credential here, so this endpoint is authenticated in
 * the only sense that matters: it answers about the code you present and
 * nothing else. Every not-yours answer is the same word (`expired`) — an
 * unknown code, a lapsed one, and an approval somebody already collected are
 * indistinguishable, because telling them apart would make this an oracle
 * about codes the caller does not hold.
 *
 * An approved code yields the token EXACTLY ONCE. The single-use latch is a
 * guarded `consumed_at` update inside the same transaction that mints the
 * session, so two polls racing the same approval produce one token and one
 * `expired`.
 *
 * Every resolved state answers 200 with a `status` field rather than mapping to
 * HTTP codes: the CLI's loop then has one JSON shape to read, and a 4xx stays
 * reserved for "your request was wrong" (bad body, rate limited).
 */

/**
 * 120 polls per minute per address. The CLI polls every 5s (12/min), so this
 * absorbs several machines behind one NAT while still capping how fast a stolen
 * device code could be replayed against the single-use latch.
 */
export const DEVICE_POLL_RATE_LIMIT = 120;
export const DEVICE_POLL_RATE_WINDOW_MS = 60_000;

const bodySchema = z.object({
  deviceCode: z.string().min(1).max(512),
});

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const limit = await consumeRateLimit({
    bucket: `cli_device_poll:${clientIp(request.headers)}`,
    limit: DEVICE_POLL_RATE_LIMIT,
    windowMs: DEVICE_POLL_RATE_WINDOW_MS,
  });
  if (!limit.allowed) {
    return fail(
      429,
      "rate_limited",
      "Polling too fast. Wait for the interval the mint response gave you.",
      { "retry-after": String(limit.retryAfterSeconds) },
    );
  }

  let deviceCode: string;
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return fail(
        400,
        "invalid_request",
        "Send `{ deviceCode }` as JSON — the value the mint response returned.",
      );
    }
    deviceCode = parsed.data.deviceCode;
  } catch {
    return fail(400, "invalid_request", "The request body must be JSON.");
  }

  const result = await cliDeviceCodeService.poll({ deviceCode });

  const body =
    result.status === "approved"
      ? {
          status: result.status,
          // The ONLY copy of this token that will ever exist outside the
          // machine that receives it.
          token: result.token,
          sessionId: result.sessionId,
          organizationId: result.organizationId,
          userId: result.userId,
        }
      : { status: result.status };

  return Response.json(body, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
