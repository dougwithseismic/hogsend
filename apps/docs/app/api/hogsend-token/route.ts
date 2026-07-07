import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  feedTokenConfigured,
  foldContactIdentity,
  mintFeedToken,
  subscribeContact,
} from "@/lib/ingest";

/** Sign-up consent breadcrumb the form drops before sign-in; consumed once here. */
const CONSENT_COOKIE = "hs_su";

/**
 * Mints the browser's Hogsend feed userToken for the signed-in visitor — the
 * engine-identified bell that powers the docs live demo. Two upstream calls run
 * in parallel, both server-side (the ingest key + mint secret never reach the
 * client): the { email, userId, firstName } contact fold (makes the Better Auth
 * id the contact's external_id, so demo captures are fork-safe) and the
 * dogfood-hosted token mint. 401 when signed out, 503 when the env isn't
 * configured, so the client provider fails quietly to the anonymous state.
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

  // Record sign-up consent ONCE. The form drops the `hs_su` cookie (value "1"
  // when they opted into product updates) right before sign-in; this first
  // authenticated token fetch records it and clears the cookie. Covers every
  // path (OTP, magic-link, GitHub) since the provider always fetches this after
  // sign-in. Best-effort — never blocks the token.
  const consent = (await cookies()).get(CONSENT_COOKIE)?.value;
  const res = NextResponse.json({ ...minted, userId });
  if (consent !== undefined) {
    await subscribeContact({ email, productUpdates: consent === "1" });
    res.cookies.set(CONSENT_COOKIE, "", { maxAge: 0, path: "/" });
  }
  return res;
}
