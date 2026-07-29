/**
 * The one vocabulary the billing route handlers and the Usage page share.
 *
 * A route that fails cannot render anything — it redirects — so what it has to
 * hand the browser is a CODE, and the page has to turn that code back into a
 * sentence. Keeping both halves here means a route can only emit a code that
 * has a sentence, and the sentence is written once rather than guessed at by
 * whichever page happens to read the query string.
 *
 * Every line is a fact about what happened, and each says what did NOT happen —
 * "no checkout session was created" is the thing a customer who just clicked
 * Upgrade actually needs to know.
 */

export const BILLING_NOTICES = {
  disabled:
    "Billing is switched off for this deployment, so no checkout session was created. Your plan is unchanged.",
  unavailable:
    "No checkout session was created: billing is not fully configured for that plan. Your plan is unchanged.",
  forbidden: "Only an owner or admin can change this organization's plan.",
  invalid_plan: "That is not a plan this control plane sells.",
  cancelled: "The checkout was cancelled. Your plan is unchanged.",
} as const;

export type BillingNoticeCode = keyof typeof BILLING_NOTICES;

/**
 * Shown when the provider returns the browser after a completed checkout.
 *
 * Deliberately does NOT claim the plan has changed: the plan is written by
 * `PlanService` from the provider's WEBHOOK, which arrives independently of the
 * redirect and can land seconds later. A line saying "you are now on
 * self-serve" would be a guess, and would read as a bug on the refresh that
 * still shows the old plan.
 */
export const CHECKOUT_COMPLETE_NOTICE =
  "Checkout completed. The plan on this page updates when the billing provider confirms the subscription.";

function isBillingNoticeCode(value: unknown): value is BillingNoticeCode {
  return typeof value === "string" && value in BILLING_NOTICES;
}

/**
 * The sentence for a `?billing=` value, or null. Unknown values return null
 * rather than an "unknown error" line: a stray query parameter is not an event
 * worth telling a customer about.
 */
export function billingNotice(
  value: string | string[] | undefined,
): string | null {
  const code = Array.isArray(value) ? value[0] : value;
  return isBillingNoticeCode(code) ? BILLING_NOTICES[code] : null;
}
