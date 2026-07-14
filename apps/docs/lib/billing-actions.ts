import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { postToHogsendApiRaw } from "@/lib/hogsend-api";

/**
 * The session-gated billing-action forward shared by the /api/billing/*
 * routes: verify the `*.hogsend.com` session, then relay the action to the
 * Hono API with the SESSION-verified identity — the security invariant is
 * that `email`/`userId` always come from the session, never the caller, so
 * the API only ever operates on the signed-in customer's own Stripe objects.
 * Upstream verdict statuses (409 not-modifiable, 401 ownership, …) pass
 * through with an empty body; anything else — network failures, 5xx
 * diagnostics, odd null-body statuses — flattens to an opaque 502 so upstream
 * error detail never reaches the browser.
 */

const RELAYED_VERDICTS = new Set([400, 401, 403, 404, 409]);

export async function forwardBillingAction(
  path: string,
  extra: Record<string, unknown>,
): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const res = await postToHogsendApiRaw(path, {
    ...extra,
    // Session identity is spread LAST so no caller-supplied key can override
    // it — the invariant is structural, not per-route convention.
    email: session.user.email,
    userId: session.user.id,
  });
  if (!res) {
    return NextResponse.json({ error: "billing unavailable" }, { status: 502 });
  }
  if (res.ok) return NextResponse.json(res.data ?? {});
  return NextResponse.json(
    {},
    { status: RELAYED_VERDICTS.has(res.status) ? res.status : 502 },
  );
}

/** Parse a JSON body, tolerating an empty one. */
export async function jsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  return body ?? {};
}
