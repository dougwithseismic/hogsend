import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

/**
 * Mints the browser's Hogsend feed userToken for the signed-in reader — the
 * engine-identified bell. Two upstream calls, both server-side (the ingest
 * key and mint secret never reach the client):
 *
 *   1. PUT /v1/contacts { email, userId } — the secret-path identity fold.
 *      Magic-link login proved the reader owns the email, so asserting the
 *      Better Auth id as the contact's external_id here is the sanctioned
 *      fill-in-link (it makes the userId the contact's canonical feed
 *      recipient key — the same contact journeys `sendFeedItem` to by email).
 *   2. POST /v1/course/feed-token — the dogfood-hosted mint (shared secret),
 *      which signs the userToken with the engine's own signing secret.
 *
 * The fold runs on every mint (hourly per user) — it's an idempotent upsert.
 * 503 when the env isn't configured, so the client bell can fail quietly.
 */

function trimBase(url: string): string {
  return url.replace(/\/+$/, "");
}

export async function POST() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ingestUrl = process.env.HOGSEND_INGEST_URL;
  const ingestKey = process.env.HOGSEND_INGEST_KEY;
  const mintSecret = process.env.HOGSEND_FEED_TOKEN_SECRET;
  if (!ingestUrl || !ingestKey || !mintSecret) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const { id: userId, email } = session.user;

  try {
    const fold = await fetch(`${trimBase(ingestUrl)}/v1/contacts`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ingestKey}`,
      },
      body: JSON.stringify({ email, userId }),
    });
    if (!fold.ok) {
      return NextResponse.json({ error: "fold_failed" }, { status: 502 });
    }

    const mint = await fetch(`${trimBase(ingestUrl)}/v1/course/feed-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-course-token-secret": mintSecret,
      },
      body: JSON.stringify({ userId }),
    });
    if (!mint.ok) {
      return NextResponse.json({ error: "mint_failed" }, { status: 502 });
    }
    const body = (await mint.json()) as {
      token?: unknown;
      expiresInSeconds?: unknown;
    };
    if (typeof body.token !== "string") {
      return NextResponse.json({ error: "mint_failed" }, { status: 502 });
    }
    return NextResponse.json({
      token: body.token,
      expiresInSeconds:
        typeof body.expiresInSeconds === "number"
          ? body.expiresInSeconds
          : 3600,
      userId,
    });
  } catch {
    return NextResponse.json(
      { error: "upstream_unreachable" },
      { status: 502 },
    );
  }
}
