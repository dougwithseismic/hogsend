import { BillingDisabledError, getBilling } from "@/src/billing";
import {
  resolveBillingCaller,
  seeOther,
  usageUrl,
} from "@/src/lib/billing-route";

/**
 * Open the provider's self-serve billing portal for the caller's organization.
 *
 * A POST rather than a link because the portal URL is a short-lived session the
 * provider mints on demand — there is nothing to put in an `href` at render
 * time, and a GET that mints one would be followable by any prefetcher.
 *
 * Same guard as checkout: the organization comes from the session, only an
 * owner or admin may open it, and every refusal is a notice on `/usage`.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const caller = await resolveBillingCaller(request.headers);
  if (!caller.allowed) return seeOther(caller.location);

  try {
    const { url } = await getBilling().getPortalUrl({
      organizationId: caller.organizationId,
    });
    return seeOther(url);
  } catch (error) {
    if (error instanceof BillingDisabledError) {
      return seeOther(usageUrl("disabled"));
    }
    console.error("[billing] portal session could not be created", {
      code: error instanceof Error ? error.name : "unknown",
    });
    return seeOther(usageUrl("unavailable"));
  }
}
