import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  feedTokenConfigured,
  foldContactIdentity,
  mintFeedToken,
  resolveContactKey,
} from "@/lib/ingest";

/**
 * Mints the browser's Hogsend feed userToken for the signed-in reader — the
 * engine-identified bell. Server-side only (the ingest key and mint secret
 * never reach the client). The fold runs on every mint (idempotent upsert);
 * the token is minted for the contact's CANONICAL feed key, not the raw Better
 * Auth id (a contact identified earlier keeps its own external_id, so minting
 * for the auth id would poll a key that never matches where journeys write —
 * an empty bell). 503 when the env isn't configured, so the bell fails quietly.
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

  // Fold first (links the Better Auth id ↔ email onto the contact), THEN resolve
  // the contact's canonical feed key and mint for it (fallback: the Better Auth
  // id, correct for a fresh contact whose external_id IS the auth id).
  const folded = await foldContactIdentity({ email, userId });
  if (!folded) {
    return NextResponse.json({ error: "fold_failed" }, { status: 502 });
  }
  const feedUserId = (await resolveContactKey({ email })) ?? userId;
  const minted = await mintFeedToken(feedUserId);
  if (!minted) {
    return NextResponse.json({ error: "mint_failed" }, { status: 502 });
  }
  // Return the canonical key as `userId` so the client identifies on the SAME
  // key the bell polls and journeys write to — read and write on one contact.
  return NextResponse.json({ ...minted, userId: feedUserId });
}
