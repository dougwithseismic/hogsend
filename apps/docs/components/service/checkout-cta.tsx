"use client";

import type { JSX } from "react";
import { Button } from "@/components/ds/button";
import { FeatureFlag, useFeatureFlag } from "@/lib/feature-flags";
import { SERVICE_TIERS, type ServiceTierId } from "@/lib/pricing";
import { CheckoutButton } from "./checkout-button";

const REACH_OUT_EMAIL = "hello@hogsend.com";

/**
 * CheckoutCta — the paid-tier call to action, gated on the
 * `service-self-serve-checkout` PostHog feature flag.
 *
 * Flag OFF (the default for everyone, and the SSR/pre-boot state): there is no
 * fulfilment pipeline behind Stripe yet, so the tier converts by a plain
 * "reach out to hello@hogsend.com" mailto rather than dead-ending in a checkout
 * we can't service. Flag ON (see FeatureFlag.SELF_SERVE_CHECKOUT for how to
 * reliably target just yourself): the real <CheckoutButton> that starts Stripe
 * Checkout.
 *
 * This gate is only for the self-serve checkout tiers (Managed / Setup). The
 * Done-for-you "book a call" flow is never routed through here — it stays live.
 */
export function CheckoutCta({
  tier,
  label,
  variant = "accent",
  next,
  className,
}: {
  tier: ServiceTierId;
  label: string;
  variant?: "accent" | "outline";
  /** Page to return to after sign-in / on cancel (e.g. "/pricing"). */
  next?: string;
  /** Extra classes for the rendered Button (e.g. "w-full justify-center"). */
  className?: string;
}): JSX.Element {
  const checkoutEnabled = useFeatureFlag(FeatureFlag.SELF_SERVE_CHECKOUT);

  if (checkoutEnabled) {
    return (
      <CheckoutButton
        tier={tier}
        label={label}
        variant={variant}
        next={next}
        className={className}
      />
    );
  }

  const subject = `Hogsend — ${SERVICE_TIERS[tier].name}`;
  const href = `mailto:${REACH_OUT_EMAIL}?subject=${encodeURIComponent(subject)}`;

  return (
    <div className="flex flex-col gap-2.5">
      <Button href={href} variant={variant} icon className={className}>
        Reach out to get started
      </Button>
      <p className="text-sm text-white/50">
        We&apos;ll get you set up — email {REACH_OUT_EMAIL}.
      </p>
    </div>
  );
}
