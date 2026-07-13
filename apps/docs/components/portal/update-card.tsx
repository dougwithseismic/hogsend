"use client";

import type { Stripe, StripeElements } from "@stripe/stripe-js";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * In-portal card update via Stripe Elements. The flow keeps the card inside
 * Stripe's iframe end to end:
 *   1. POST /api/billing/setup-intent → { clientSecret } (minted API-side for
 *      the session-verified customer)
 *   2. mount the Payment Element with that secret; the customer types the
 *      card into Stripe's iframe — it never touches our servers
 *   3. stripe.confirmSetup (no redirect for cards)
 *   4. POST /api/billing/confirm-card → the API makes it the default on the
 *      customer + their subscriptions
 *
 * Renders nothing when NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is unset (the env
 * is inlined at build time) — the rest of the billing section still works.
 */

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

type Phase = "idle" | "loading" | "ready" | "saving" | "done";

export function UpdateCard() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const stripeRef = useRef<Stripe | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);

  // Mount the Payment Element once the container exists (phase "ready" render
  // happens before Stripe paints into it).
  useEffect(() => {
    if (phase === "ready" && mountRef.current && elementsRef.current) {
      const payment = elementsRef.current.create("payment");
      payment.mount(mountRef.current);
      return () => payment.unmount();
    }
  }, [phase]);

  if (!PUBLISHABLE_KEY) return null;

  async function begin() {
    setPhase("loading");
    setError(null);
    try {
      const [{ loadStripe }, res] = await Promise.all([
        import("@stripe/stripe-js"),
        fetch("/api/billing/setup-intent", { method: "POST" }),
      ]);
      if (!res.ok) throw new Error(`setup-intent ${res.status}`);
      const { clientSecret } = (await res.json()) as {
        clientSecret?: string;
      };
      const stripe = PUBLISHABLE_KEY ? await loadStripe(PUBLISHABLE_KEY) : null;
      if (!stripe || !clientSecret) throw new Error("stripe unavailable");
      stripeRef.current = stripe;
      elementsRef.current = stripe.elements({
        clientSecret,
        appearance: { theme: "night", variables: { colorPrimary: "#f64838" } },
      });
      setPhase("ready");
    } catch {
      setError("Couldn't start the card update — try again in a moment.");
      setPhase("idle");
    }
  }

  async function save() {
    const stripe = stripeRef.current;
    const elements = elementsRef.current;
    if (!stripe || !elements) return;
    setPhase("saving");
    setError(null);
    try {
      const result = await stripe.confirmSetup({
        elements,
        redirect: "if_required",
      });
      if (result.error) {
        setError(result.error.message ?? "Card confirmation failed.");
        setPhase("ready");
        return;
      }
      const confirm = await fetch("/api/billing/confirm-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setupIntentId: result.setupIntent.id }),
      });
      if (!confirm.ok) {
        setError("Card saved with Stripe but not applied — contact Doug.");
        setPhase("ready");
        return;
      }
      setPhase("done");
      router.refresh();
    } catch {
      setError("That didn't take — try again in a moment.");
      setPhase("ready");
    }
  }

  if (phase === "done") {
    return (
      <p className="text-sm text-white/70">
        Card updated — future renewals charge the new card.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {phase === "idle" || phase === "loading" ? (
        <button
          type="button"
          disabled={phase === "loading"}
          onClick={begin}
          className="inline-flex h-10 w-fit items-center rounded-[8px] border border-white/[0.12] px-4 font-medium text-sm text-white/80 transition-colors hover:border-white/30 hover:text-white disabled:opacity-60"
        >
          {phase === "loading" ? "Opening…" : "Update card"}
        </button>
      ) : (
        <>
          <div ref={mountRef} />
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={phase === "saving"}
              onClick={save}
              className="inline-flex h-10 items-center rounded-[8px] bg-white px-4 font-medium text-[#0a0a0a] text-sm transition-colors hover:bg-white/90 disabled:opacity-60"
            >
              {phase === "saving" ? "Saving…" : "Save card"}
            </button>
            <button
              type="button"
              disabled={phase === "saving"}
              onClick={() => setPhase("idle")}
              className="text-sm text-white/60 transition-colors hover:text-white"
            >
              Cancel
            </button>
          </div>
        </>
      )}
      {error ? <p className="text-red-400/90 text-sm">{error}</p> : null}
    </div>
  );
}
