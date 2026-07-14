"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ACTION_FAILED, postPortalAction } from "./post-action";

/**
 * Cancel-at-period-end / resume controls for one subscription. Two-step on
 * cancel (inline confirm, no browser dialog); a success refreshes the server
 * component so the card re-renders with live Stripe state. Upstream verdicts
 * surface as inline copy — a 409 means the subscription is no longer
 * modifiable (already fully canceled).
 */
export function SubscriptionActions({
  subscriptionId,
  cancelAtPeriodEnd,
}: {
  subscriptionId: string;
  cancelAtPeriodEnd: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setCancel(cancel: boolean) {
    setPending(true);
    setError(null);
    const res = await postPortalAction("/api/billing/subscription", {
      subscriptionId,
      cancel,
    });
    if (!res.ok) {
      setError(
        res.status === 409
          ? "This subscription can't be changed any more."
          : ACTION_FAILED,
      );
      setPending(false);
      return;
    }
    // Stay pending until the refresh lands — the parent keys this island on
    // cancelAtPeriodEnd, so the flipped server state remounts it with fresh
    // controls instead of briefly re-offering the stale action.
    router.refresh();
  }

  const linkClass =
    "text-white/60 text-xs underline decoration-white/30 underline-offset-4 transition-colors hover:text-white disabled:opacity-50";

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      {cancelAtPeriodEnd ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => setCancel(false)}
          className={linkClass}
        >
          {pending ? "Resuming…" : "Resume subscription"}
        </button>
      ) : confirming ? (
        <>
          <span className="text-white/60 text-xs">
            Cancel at the end of the period?
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={() => setCancel(true)}
            className="text-accent text-xs underline decoration-accent/40 underline-offset-4 disabled:opacity-50"
          >
            {pending ? "Cancelling…" : "Yes, cancel"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirming(false)}
            className={linkClass}
          >
            Keep it
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className={linkClass}
        >
          Cancel subscription
        </button>
      )}
      {error ? <span className="text-red-400/90 text-xs">{error}</span> : null}
    </div>
  );
}
