import { NextResponse } from "next/server";

const TOKEN_MAX_LENGTH = 2048;
const DISTINCT_ID_MAX_LENGTH = 200;

/**
 * sanitizeCurrentDistinctId — the caller's OWN browser anonymous distinct_id,
 * forwarded to the engine so the server can `alias` it into the token-proven
 * canonical key. Structurally safe: a caller can only ever absorb their own
 * session, never name a victim's. Optional and best-effort.
 */
function sanitizeCurrentDistinctId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > DISTINCT_ID_MAX_LENGTH) {
    return undefined;
  }
  return trimmed;
}

/**
 * POST /api/identity — exchanges a redirect identity token (`hs_t`, appended
 * by the Hogsend engine to tracked email links when TRACKING_IDENTITY_TOKEN
 * is on) for the distinct id, by proxying to the instance's
 * `POST /v1/t/identify`. The proxy keeps the Hogsend URL server-side; the
 * token itself is the authorization (signed, one-hour expiry), so no API key
 * travels with this request.
 *
 * When the caller passes its own `currentDistinctId` (its browser anon id),
 * it is forwarded so the engine performs a server-side `alias` — folding this
 * session into the token's canonical person. That alias is immune to browser
 * persistence resets; the client `identify` below stays a same-session
 * convenience, no longer the durable stitch.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const baseUrl = process.env.HOGSEND_INGEST_URL;
  if (!baseUrl) {
    return NextResponse.json(
      { error: "identity not configured" },
      { status: 503 },
    );
  }

  let token: unknown;
  let currentDistinctId: string | undefined;
  try {
    const body = (await request.json()) as {
      token?: unknown;
      currentDistinctId?: unknown;
    };
    token = body?.token;
    currentDistinctId = sanitizeCurrentDistinctId(body?.currentDistinctId);
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > TOKEN_MAX_LENGTH
  ) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }

  try {
    const upstream = await fetch(
      `${baseUrl.replace(/\/+$/, "")}/v1/t/identify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          ...(currentDistinctId ? { currentDistinctId } : {}),
        }),
      },
    );
    if (!upstream.ok) {
      return NextResponse.json({ error: "invalid token" }, { status: 400 });
    }
    const payload = (await upstream.json()) as { distinctId?: string };
    if (!payload.distinctId) {
      return NextResponse.json({ error: "invalid token" }, { status: 400 });
    }
    return NextResponse.json({ distinctId: payload.distinctId });
  } catch {
    return NextResponse.json({ error: "upstream error" }, { status: 502 });
  }
}
