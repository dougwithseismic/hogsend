import type { NextResponse } from "next/server";
import { forwardBillingAction, jsonBody } from "@/lib/billing-actions";

export const runtime = "nodejs";

/** POST /api/billing/confirm-card — after Stripe Elements confirms the
 *  SetupIntent client-side, make that card the default. */
export async function POST(request: Request): Promise<NextResponse> {
  const body = await jsonBody(request);
  return forwardBillingAction("/me/billing/confirm-card", {
    setupIntentId: body.setupIntentId,
  });
}
