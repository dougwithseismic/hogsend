import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  feedTokenConfigured,
  foldContactIdentity,
  mintFeedToken,
} from "@/lib/ingest";

/**
 * Mints the browser's Hogsend feed userToken for the signed-in reader — the
 * engine-identified bell. Two independent upstream calls run in parallel
 * (both server-side; the ingest key and mint secret never reach the client):
 * the { email, userId } contact fold and the dogfood-hosted token mint (see
 * lib/ingest.ts for both). The fold runs on every mint (hourly per user) —
 * it's an idempotent upsert. 503 when the env isn't configured, so the
 * client bell can fail quietly.
 */
export async function POST() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!feedTokenConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const { id: userId, email } = session.user;
  const [folded, minted] = await Promise.all([
    foldContactIdentity({ email, userId }),
    mintFeedToken(userId),
  ]);
  if (!folded) {
    return NextResponse.json({ error: "fold_failed" }, { status: 502 });
  }
  if (!minted) {
    return NextResponse.json({ error: "mint_failed" }, { status: 502 });
  }
  return NextResponse.json({ ...minted, userId });
}
