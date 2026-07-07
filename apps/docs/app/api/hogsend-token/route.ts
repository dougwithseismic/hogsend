import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  feedTokenConfigured,
  foldContactIdentity,
  mintFeedToken,
} from "@/lib/ingest";

/**
 * Mints the browser's Hogsend feed userToken for the signed-in visitor — the
 * engine-identified bell that powers the docs live demo. Two upstream calls run
 * in parallel, both server-side (the ingest key + mint secret never reach the
 * client): the { email, userId, firstName } contact fold (makes the Better Auth
 * id the contact's external_id, so demo captures are fork-safe) and the
 * dogfood-hosted token mint. 401 when signed out, 503 when the env isn't
 * configured, so the client provider fails quietly to the anonymous state.
 *
 * Sign-up consent is NOT recorded here — the form records it at request time via
 * /api/subscribe (email-keyed, device-independent) so it never depends on this
 * mint succeeding, and survives a cross-device magic-link completion.
 */
export async function POST() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!feedTokenConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const { id: userId, email, name } = session.user;
  // First token of the display name (set at sign-in). Empty ⇒ omit, so the fold
  // never writes a blank firstName over a good one.
  const firstName = (name ?? "").trim().split(/\s+/)[0] || undefined;
  const [folded, minted] = await Promise.all([
    foldContactIdentity({ email, userId, firstName }),
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
