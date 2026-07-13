import type { NextResponse } from "next/server";
import { forwardBillingAction } from "@/lib/billing-actions";

export const runtime = "nodejs";

/** POST /api/billing/setup-intent — mint a SetupIntent for the signed-in
 *  customer's in-portal card update. Returns `{ clientSecret }`. */
export async function POST(): Promise<NextResponse> {
  return forwardBillingAction("/me/billing/setup-intent", {});
}
