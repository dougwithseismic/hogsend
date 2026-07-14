"use client";

import type { Stripe, StripeElements } from "@stripe/stripe-js";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ACTION_FAILED, postPortalAction } from "./post-action";

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
  // The Elements group is state (not a ref) so the mount effect runs exactly
  // once per group: Stripe allows ONE payment element per group, and the form
  // stays in the DOM across ready↔saving — keying the effect on `phase` would
  // tear the iframe down mid-confirmSetup and throw on re-create.
  const [elements, setElements] = useState<StripeElements | null>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const stripeRef = useRef<Stripe | null>(null);
  // Set once confirmSetup succeeds — a failed confirm-card POST then retries
  // the POST alone (confirmSetup on a succeeded SetupIntent throws).
  const confirmedIntentRef = useRef<string | null>(null);

  useEffect(() => {
    if (!elements || !mountRef.current) return;
    const payment = elements.create("payment");
    payment.mount(mountRef.current);
    return () => payment.unmount();
  }, [elements]);

  if (!PUBLISHABLE_KEY) return null;

  function close(next: Extract<Phase, "idle" | "done">) {
    setElements(null);
    confirmedIntentRef.current = null;
    setPhase(next);
  }

  async function begin() {
    // The component early-returns above, but TS can't narrow the module
    // const into this closure.
    if (!PUBLISHABLE_KEY) return;
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
      const stripe = await loadStripe(PUBLISHABLE_KEY);
      if (!stripe || !clientSecret) throw new Error("stripe unavailable");
      stripeRef.current = stripe;
      confirmedIntentRef.current = null;
      setElements(
        stripe.elements({
          clientSecret,
          appearance: {
            theme: "night",
            variables: { colorPrimary: "#f64838" },
          },
        }),
      );
      setPhase("ready");
    } catch {
      setError("Couldn't start the card update — try again in a moment.");
      setPhase("idle");
    }
  }

  async function save() {
    const stripe = stripeRef.current;
    if (!stripe || !elements) return;
    setPhase("saving");
    setError(null);
    try {
      if (!confirmedIntentRef.current) {
        const result = await stripe.confirmSetup({
          elements,
          redirect: "if_required",
        });
        if (result.error) {
          setError(result.error.message ?? "Card confirmation failed.");
          setPhase("ready");
          return;
        }
        confirmedIntentRef.current = result.setupIntent.id;
      }
      const confirm = await postPortalAction("/api/billing/confirm-card", {
        setupIntentId: confirmedIntentRef.current,
      });
      if (!confirm.ok) {
        setError(
          "Card confirmed with Stripe but not applied yet — press Save card to retry.",
        );
        setPhase("ready");
        return;
      }
      close("done");
      router.refresh();
    } catch {
      setError(ACTION_FAILED);
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
      {elements === null ? (
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
              onClick={() => close("idle")}
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
