import type { NextResponse } from "next/server";
import { forwardBillingAction, jsonBody } from "@/lib/billing-actions";

export const runtime = "nodejs";

/** POST /api/billing/subscription — cancel at period end / resume the
 *  signed-in customer's own subscription. */
export async function POST(request: Request): Promise<NextResponse> {
  const body = await jsonBody(request);
  return forwardBillingAction("/me/billing/subscription", {
    subscriptionId: body.subscriptionId,
    cancel: body.cancel,
  });
}
