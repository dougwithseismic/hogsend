"use client";

import type { JSX, KeyboardEvent } from "react";
import { useState } from "react";
import { Card } from "@/components/ds/card";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { AnalyticsEvent, capture } from "@/lib/analytics";

/* ------------------------------------------------------------------------ */
/*  Verified figures — resend.com/pricing, checked June 2026.                */
/*  Loops: $249/month at 50,000 contacts (Loops' published pricing,          */
/*  June 2026). Nothing else on this page is interpolated or invented.       */
/* ------------------------------------------------------------------------ */

/** Slider stops for subscribed contacts. */
const CONTACT_STEPS = [
  1_000, 2_500, 5_000, 10_000, 15_000, 25_000, 50_000, 100_000, 150_000,
  250_000,
] as const;

/** Slider stops for emails sent per month — aligned to Resend's tiers. */
const SEND_STEPS = [
  3_000, 10_000, 25_000, 50_000, 100_000, 200_000, 500_000, 1_000_000,
  1_500_000, 2_500_000,
] as const;

type Tier = {
  /** Largest volume the tier covers. */
  upTo: number;
  /** Monthly price in USD. */
  price: number;
  /** Tier name as published. */
  name: string;
};

/** Resend Marketing (contact-metered) — resend.com/pricing, June 2026. */
const RESEND_MARKETING_TIERS: Tier[] = [
  { upTo: 1_000, price: 0, name: "Free" },
  { upTo: 5_000, price: 40, name: "Pro" },
  { upTo: 10_000, price: 80, name: "Pro" },
  { upTo: 15_000, price: 120, name: "Pro" },
  { upTo: 25_000, price: 180, name: "Pro" },
  { upTo: 50_000, price: 250, name: "Pro" },
  { upTo: 100_000, price: 450, name: "Pro" },
  { upTo: 150_000, price: 650, name: "Pro" },
];

/** Resend transactional (send-metered) — resend.com/pricing, June 2026. */
const RESEND_TRANSACTIONAL_TIERS: Tier[] = [
  { upTo: 3_000, price: 0, name: "Free" },
  { upTo: 50_000, price: 20, name: "Pro" },
  { upTo: 100_000, price: 35, name: "Pro" },
  { upTo: 200_000, price: 160, name: "Scale" },
  { upTo: 500_000, price: 350, name: "Scale" },
  { upTo: 1_000_000, price: 650, name: "Scale" },
  { upTo: 1_500_000, price: 825, name: "Scale" },
  { upTo: 2_500_000, price: 1_150, name: "Scale" },
];

/** Cheapest published tier that covers `volume`, or null (custom pricing). */
function tierFor(tiers: Tier[], volume: number): Tier | null {
  return tiers.find((tier) => volume <= tier.upTo) ?? null;
}

const numberFormat = new Intl.NumberFormat("en-US");

function formatCount(value: number): string {
  return numberFormat.format(value);
}

function formatPrice(price: number): string {
  return `$${numberFormat.format(price)}`;
}

/* ------------------------------------------------------------------------ */
/*  Slider                                                                   */
/* ------------------------------------------------------------------------ */

const COMMIT_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

type CalcSliderProps = {
  label: string;
  steps: readonly number[];
  index: number;
  onIndexChange: (index: number) => void;
  /** Fired on release (pointer up / key up), not continuously. */
  onCommit: () => void;
};

function CalcSlider({
  label,
  steps,
  index,
  onIndexChange,
  onCommit,
}: CalcSliderProps): JSX.Element {
  const value = steps[index] ?? steps[0] ?? 0;

  function handleKeyUp(event: KeyboardEvent<HTMLInputElement>): void {
    if (COMMIT_KEYS.has(event.key)) onCommit();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <span className="eyebrow text-white/50">{label}</span>
        <span className="font-mono text-sm text-white tabular-nums">
          {formatCount(value)}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={steps.length - 1}
        step={1}
        value={index}
        aria-label={label}
        aria-valuetext={formatCount(value)}
        onChange={(event) => onIndexChange(Number(event.currentTarget.value))}
        onPointerUp={onCommit}
        onKeyUp={handleKeyUp}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-white/[0.08] outline-none focus-visible:ring-1 focus-visible:ring-accent/60 [&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-accent [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent"
      />
      <div className="flex justify-between font-mono text-white/40 text-xs tabular-nums">
        <span>{formatCount(steps[0] ?? 0)}</span>
        <span>{formatCount(steps[steps.length - 1] ?? 0)}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/*  Calculator                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Pricing calculator — two sliders (contacts, sends/month) against verified
 * published tiers. The per-contact column quotes Resend Marketing's
 * contact-metered tiers; the Hogsend column is licence $0 + the Resend
 * transactional tier the sends fit in + your existing infra. Fires
 * `docs.calculator_used` on slider release only.
 */
export function PricingCalculator(): JSX.Element {
  // Defaults: 25,000 contacts / 50,000 sends per month.
  const [contactsIndex, setContactsIndex] = useState(5);
  const [sendsIndex, setSendsIndex] = useState(3);

  const contacts = CONTACT_STEPS[contactsIndex] ?? CONTACT_STEPS[0];
  const sends = SEND_STEPS[sendsIndex] ?? SEND_STEPS[0];

  const contactTier = tierFor(RESEND_MARKETING_TIERS, contacts);
  const sendTier = tierFor(RESEND_TRANSACTIONAL_TIERS, sends);

  function handleCommit(): void {
    capture(AnalyticsEvent.CALCULATOR_USED, { contacts, sends });
  }

  return (
    <Section>
      <SectionHeading
        eyebrow="At your size"
        title="Two structures, side by side"
        subtitle="Set your list size and monthly send volume. One column is metered on contacts; the other has no per-contact line item."
      />

      <Reveal delay={0.08} className="mt-12">
        <Card className="rounded-[10px] bg-white/[0.02] p-8">
          <div className="grid gap-x-12 gap-y-8 md:grid-cols-2">
            <CalcSlider
              label="Subscribed contacts"
              steps={CONTACT_STEPS}
              index={contactsIndex}
              onIndexChange={setContactsIndex}
              onCommit={handleCommit}
            />
            <CalcSlider
              label="Emails sent / month"
              steps={SEND_STEPS}
              index={sendsIndex}
              onIndexChange={setSendsIndex}
              onCommit={handleCommit}
            />
          </div>
        </Card>
      </Reveal>

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        {/* Per-contact comparison — Resend Marketing's published tiers. */}
        <Reveal delay={0.12}>
          <Card className="h-full rounded-[10px] bg-white/[0.02] p-8">
            <p className="eyebrow text-white/50">Contact-metered platform</p>

            <div className="mt-5 flex items-baseline gap-1.5">
              {contactTier ? (
                <>
                  <span className="font-mono text-[32px] text-white leading-[40px] tabular-nums">
                    {formatPrice(contactTier.price)}
                  </span>
                  <span className="text-base text-white/60">/month</span>
                </>
              ) : (
                <span className="font-mono text-[32px] text-white leading-[40px]">
                  Custom
                </span>
              )}
            </div>

            <p className="mt-3 text-sm text-white/60 leading-6">
              {contactTier
                ? `Resend Marketing at ${formatCount(contacts)} contacts.`
                : `Resend Marketing lists no tier past 150,000 contacts — Enterprise, custom pricing.`}
            </p>

            <div className="mt-6 border-white/[0.08] border-t pt-5">
              <p className="text-sm text-white/60 leading-6">
                For reference, Loops&apos; published pricing is{" "}
                <span className="font-mono text-white/80">$249/month</span> at
                50,000 contacts.
              </p>
            </div>

            <p className="mt-5 text-sm text-white/60 leading-6">
              The price moves with the list, whether or not you send.
            </p>
          </Card>
        </Reveal>

        {/* Hogsend's structure — licence, provider tier, infra. */}
        <Reveal delay={0.16}>
          <Card className="h-full rounded-[10px] border-accent/40 bg-white/[0.02] p-8">
            <p className="eyebrow text-white/50">Hogsend, self-hosted</p>

            <div className="mt-5 flex flex-col gap-4">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-sm text-white/60">Licence</span>
                <span className="font-mono text-base text-white tabular-nums">
                  $0
                </span>
              </div>

              <div className="flex items-baseline justify-between gap-4">
                <span className="text-sm text-white/60">
                  Provider{" "}
                  {sendTier
                    ? `(Resend ${sendTier.name}, ${formatCount(
                        sendTier.upTo,
                      )} emails)`
                    : "(Resend Enterprise)"}
                </span>
                <span className="font-mono text-base text-white tabular-nums">
                  {sendTier ? `${formatPrice(sendTier.price)}/mo` : "Custom"}
                </span>
              </div>

              <div className="flex items-baseline justify-between gap-4">
                <span className="text-sm text-white/60">Infrastructure</span>
                <span className="text-right text-sm text-white/80">
                  your existing Postgres/Redis/Railway bill
                </span>
              </div>
            </div>

            <div className="mt-6 border-white/[0.08] border-t pt-5">
              <p className="text-sm text-white/80 leading-6">
                No per-contact line item. At {formatCount(contacts)} contacts
                the licence is still $0 — your database gets more rows.
              </p>
            </div>
          </Card>
        </Reveal>
      </div>

      <Reveal delay={0.2}>
        <p className="eyebrow mt-4 text-white/50">
          Resend tiers from resend.com/pricing; Loops figure is Loops&apos;
          published pricing at 50,000 contacts. Both checked June 2026.
        </p>
      </Reveal>
    </Section>
  );
}
