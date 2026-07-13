import type { JSX } from "react";
import { Button } from "@/components/ds/button";
import type { ServiceTierId } from "@/lib/pricing";

/**
 * Buy-now CTA for a self-serve service tier. A plain HTML form POST to
 * /api/checkout (no client JS, no card handling) — the route creates the Stripe
 * Checkout Session and 303-redirects to Stripe's hosted page. Signed-out
 * visitors are bounced through sign-in and the purchase resumes on return.
 */
export function CheckoutButton({
  tier,
  label,
  variant = "accent",
  next,
}: {
  tier: ServiceTierId;
  label: string;
  variant?: "accent" | "outline";
  /** Page to return to after sign-in / on cancel (e.g. "/pricing"). */
  next?: string;
}): JSX.Element {
  return (
    <form method="post" action="/api/checkout">
      <input type="hidden" name="tier" value={tier} />
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <Button type="submit" variant={variant} icon>
        {label}
      </Button>
    </form>
  );
}
