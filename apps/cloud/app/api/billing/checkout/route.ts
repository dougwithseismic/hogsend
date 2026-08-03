import { BillingDisabledError, getBilling, isBillingPlan } from "@/src/billing";
import {
  cloudUrl,
  resolveBillingCaller,
  seeOther,
  usageUrl,
} from "@/src/lib/billing-route";

/**
 * Start a checkout for one of the paid tiers (PRD 06 task 3).
 *
 * A form POST in, a 303 to the provider's hosted page out. Four things it owes:
 *
 *  1. **The organization comes from the session.** Never from the form — see
 *     `lib/billing-route.ts`. There is no request field that names a tenant.
 *  2. **Only an owner or admin.** A hidden button is not a permission check.
 *  3. **Every refusal is a NOTICE, not a crash.** Billing switched off, a
 *     missing price id, a provider that is down: each redirects back to
 *     `/usage` with a code the page turns into a sentence. A customer who
 *     clicked Upgrade gets told what happened and what did not.
 *  4. **Nothing here logs a payload.** The provider's error `code` only.
 */

// The verdict depends on the live session and live provider config.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const caller = await resolveBillingCaller(request.headers);
  if (!caller.allowed) return seeOther(caller.location);

  const form = await request.formData();
  const plan = form.get("plan");
  // `trial` is a control-plane state, never a subscription — `isBillingPlan`
  // is what says so, and it is the same predicate the provider seam uses.
  if (!isBillingPlan(plan)) return seeOther(usageUrl("invalid_plan"));

  try {
    const { url } = await getBilling().createCheckout({
      organizationId: caller.organizationId,
      plan,
      // Both land back on Usage: it is the page that shows what the plan now
      // allows, and the one the upgrade was started from.
      successUrl: cloudUrl("/usage?checkout=complete"),
      cancelUrl: cloudUrl("/usage?billing=cancelled"),
    });
    return seeOther(url);
  } catch (error) {
    if (error instanceof BillingDisabledError) {
      return seeOther(usageUrl("disabled"));
    }
    console.error("[billing] checkout could not be created", {
      code: error instanceof Error ? error.name : "unknown",
    });
    return seeOther(usageUrl("unavailable"));
  }
}
