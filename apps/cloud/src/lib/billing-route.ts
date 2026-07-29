import { env } from "../env";
import { auth } from "./auth";
import type { BillingNoticeCode } from "./billing-notice";
import {
  canManageMembers,
  NotPermittedError,
  readMemberContext,
} from "./org-members";

/**
 * The shared guard for the two billing route handlers.
 *
 * `proxy.ts` excludes `/api` from its matcher wholesale — correct for the
 * provider webhook (Stripe carries no cookie) and exactly wrong to inherit
 * here. `/api/billing/checkout` starts a paid subscription for a named
 * organization and `/api/billing/portal` opens a session that can cancel one,
 * so both resolve the caller themselves.
 *
 * Two rules, and the second is the one that matters:
 *  1. a caller with no session is sent to sign in;
 *  2. the organization is taken from the SESSION, never from the request. The
 *     handlers do not read an organization id off the form at all — there is no
 *     field to forge, and no branch where a tenant id from the outside is
 *     trusted.
 *
 * The role gate is the same one the members and environment surfaces use: a
 * plain member may look at usage, only an owner or admin may change what the
 * organization is billed.
 */

export type BillingCaller =
  | { allowed: true; organizationId: string }
  | { allowed: false; location: string };

/** An absolute URL on this deployment. Absolute because a redirect from a
 * route handler is served to a browser, not resolved against a page. */
export function cloudUrl(path: string): string {
  return new URL(path, env.CLOUD_PUBLIC_URL).toString();
}

/** The Usage page, optionally carrying a notice code the page renders. */
export function usageUrl(notice?: BillingNoticeCode): string {
  return cloudUrl(notice ? `/usage?billing=${notice}` : "/usage");
}

/**
 * 303, because the browser arrived here by POSTing a form: a 302 would let it
 * repeat the POST against the redirect target, and a repeated checkout POST is
 * a second subscription.
 */
export function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}

/** Who is calling, and may they change this organization's billing. */
export async function resolveBillingCaller(
  headers: Headers,
): Promise<BillingCaller> {
  const session = await auth.api.getSession({ headers });
  if (!session) return { allowed: false, location: cloudUrl("/login") };

  try {
    const context = await readMemberContext(headers);
    if (!canManageMembers(context.role)) {
      return { allowed: false, location: usageUrl("forbidden") };
    }
    return { allowed: true, organizationId: context.organizationId };
  } catch (error) {
    // A signed-in user who is in no organization has nothing to buy a plan
    // for; anything else here is the same refusal wearing a different message.
    if (error instanceof NotPermittedError) {
      return { allowed: false, location: usageUrl("forbidden") };
    }
    throw error;
  }
}
