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
 * Upstream verdicts (409 not-modifiable, 401 ownership) pass through;
 * network/unconfigured degrade to 502.
 */
export async function forwardBillingAction(
  path: string,
  extra: Record<string, unknown>,
): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const res = await postToHogsendApiRaw(path, {
    email: session.user.email,
    userId: session.user.id,
    ...extra,
  });
  if (!res) {
    return NextResponse.json({ error: "billing unavailable" }, { status: 502 });
  }
  return NextResponse.json(res.data ?? {}, { status: res.status });
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
