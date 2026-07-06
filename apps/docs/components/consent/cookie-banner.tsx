"use client";

import Link from "next/link";
import { type JSX, useEffect, useState } from "react";
import {
  type ConsentStatus,
  denyConsent,
  getConsentStatus,
  getDistinctId,
  grantStorageConsent,
  onConsentChange,
  withdrawConsent,
} from "@/lib/analytics";

/**
 * Custom event the footer's "Cookie settings" link dispatches to reopen this
 * card after a decision was recorded (the banner itself only auto-shows while
 * the device is undecided).
 */
export const COOKIE_SETTINGS_EVENT = "hs:cookie-settings";

export function openCookieSettings(): void {
  window.dispatchEvent(new Event(COOKIE_SETTINGS_EVENT));
}

/**
 * Best-effort audit trail: forwards the decision to the Hogsend ingest API
 * (via /api/consent) so consent is demonstrable server-side (GDPR art. 7(1)).
 * Carries the PostHog distinct_id as `anonymousId` — durable at grant time
 * (call AFTER granting), still-durable at withdraw time (call BEFORE
 * withdrawing). Refusals stay device-local: a declining visitor has no stable
 * id to key an event on, and nothing was stored that needs proving.
 */
function recordConsentEvent(action: "granted" | "withdrawn"): void {
  const distinctId = getDistinctId();
  if (!distinctId) return;
  void fetch("/api/consent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, distinctId }),
    keepalive: true,
  }).catch(() => {
    // Best-effort — the device-local ledger is the operative record.
  });
}

/**
 * CookieBanner — the consent surface for the docs site's storage upgrade.
 *
 * The site is cookieless by default (PostHog "memory" persistence, Hogsend
 * SDK on a memory-gated adapter), so this is NOT a blocking cookie wall: it
 * offers the durable upgrade once, bottom-left, and remembers either answer.
 * Both choices are one click and equally prominent. The EmailCapture terms
 * checkbox grants the same consent (plus identification), so a subscriber
 * never sees this card again; `onConsentChange` keeps the two in sync.
 */
export function CookieBanner(): JSX.Element | null {
  const [status, setStatus] = useState<ConsentStatus>(null);
  const [open, setOpen] = useState(false);
  // Decided-this-visit flag: after a click the card thanks-and-fades rather
  // than vanishing mid-read. Kept simple — a short timeout then unmount.
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const current = getConsentStatus();
    setStatus(current);
    // Auto-show only while undecided; afterwards the footer link reopens it.
    setOpen(current === null);

    const offConsent = onConsentChange((next) => {
      setStatus(next);
    });
    const reopen = () => {
      setClosing(false);
      setStatus(getConsentStatus());
      setOpen(true);
    };
    window.addEventListener(COOKIE_SETTINGS_EVENT, reopen);
    return () => {
      offConsent();
      window.removeEventListener(COOKIE_SETTINGS_EVENT, reopen);
    };
  }, []);

  if (!open) return null;

  const close = () => {
    setClosing(true);
    window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 200);
  };

  const allow = () => {
    grantStorageConsent();
    // After the upgrade the distinct_id is durable — record it.
    recordConsentEvent("granted");
    close();
  };

  const decline = () => {
    if (status === "granted") {
      // Withdraw: audit first (while the durable id still exists), then wipe.
      recordConsentEvent("withdrawn");
      withdrawConsent();
    } else {
      denyConsent();
    }
    close();
  };

  return (
    <aside
      aria-label="Cookie settings"
      className={`fixed bottom-4 left-4 z-50 w-[calc(100vw-2rem)] max-w-sm rounded-md border border-white/[0.08] bg-[#0d0d0d] p-5 text-white shadow-[0_8px_32px_rgba(0,0,0,0.5)] transition-opacity duration-200 ${
        closing ? "opacity-0" : "opacity-100"
      }`}
    >
      <p className="font-medium text-sm tracking-[-0.01em]">
        Cookieless by default
      </p>
      <p className="mt-2 text-sm text-white/70 leading-relaxed">
        {status === "granted"
          ? "This device currently allows analytics storage: one first-party id so your visits count as one visitor. Withdraw below and we go back to storing nothing."
          : "This site stores nothing in your browser right now — analytics runs cookieless and forgets you between visits. Allow storage and your return visits count as one visitor: one first-party id, our own PostHog (EU), no ad networks."}
      </p>
      <div className="mt-4 flex items-center gap-2">
        {status !== "granted" ? (
          <button
            type="button"
            onClick={allow}
            className="h-9 rounded-[8px] bg-white px-4 font-medium text-[#0a0a0a] text-sm transition-colors hover:bg-white/90"
          >
            Allow
          </button>
        ) : null}
        <button
          type="button"
          onClick={decline}
          className="h-9 rounded-[8px] bg-white/10 px-4 font-medium text-sm text-white transition-colors hover:bg-white/15"
        >
          {status === "granted"
            ? "Withdraw — store nothing"
            : "Stay cookieless"}
        </button>
      </div>
      <p className="mt-3 text-white/45 text-xs">
        Change any time via “Cookie settings” in the footer.{" "}
        <Link href="/privacy" className="underline hover:text-white/70">
          Privacy policy
        </Link>
      </p>
    </aside>
  );
}
