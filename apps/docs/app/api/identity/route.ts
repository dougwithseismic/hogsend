import { NextResponse } from "next/server";

const TOKEN_MAX_LENGTH = 2048;

/**
 * POST /api/identity — exchanges a redirect identity token (`hs_t`, appended
 * by the Hogsend engine to tracked email links when TRACKING_IDENTITY_TOKEN
 * is on) for the distinct id, by proxying to the instance's
 * `POST /v1/t/identify`. The proxy keeps the Hogsend URL server-side; the
 * token itself is the authorization (signed, one-hour expiry), so no API key
 * travels with this request.
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
  try {
    ({ token } = await request.json());
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
        body: JSON.stringify({ token }),
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
