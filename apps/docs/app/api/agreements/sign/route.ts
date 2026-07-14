import type { NextResponse } from "next/server";
import { forwardBillingAction, jsonBody } from "@/lib/billing-actions";

export const runtime = "nodejs";

/**
 * POST /api/agreements/sign — record the signed-in customer's click-wrap
 * acceptance. Identity comes from the verified session (never the caller);
 * the audit IP/user-agent are read server-side from THIS request so the
 * upstream record reflects the real signer, not the docs server.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = await jsonBody(request);
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;
  return forwardBillingAction("/me/agreements/sign", {
    docId: body.docId,
    docVersion: body.docVersion,
    contentHash: body.contentHash,
    signedName: body.signedName,
    ip,
    userAgent: request.headers.get("user-agent") ?? undefined,
  });
}
