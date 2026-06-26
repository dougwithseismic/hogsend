"use client";

import { useHogsendFeed } from "@hogsend/react";
import { Bell } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  isHogsendConfigured,
  OPEN_FEED_EVENT,
} from "@/components/hogsend/config";
import { LINKEDIN_URL } from "@/lib/site";

/**
 * The top announcement banner, emboldened with the feed. For a cold visitor it's
 * the classic "Hogsend is brand new" notice with a "Try it live" CTA. Once we
 * know the visitor (a name they typed in the live demo, stored site-wide) it
 * greets them — "Nice to see you, {name}!" — and tickers their REAL in-app
 * notifications in realtime: a new item (a journey reaching their browser) jumps
 * to the front. The bell in the nav is the durable inbox; this is the ambient
 * pulse — and clicking it opens the bell's feed (it dispatches OPEN_FEED_EVENT;
 * the on-screen NavBell catches it).
 *
 * Coherence: when a real notification is tickering we show ONLY it (not the
 * greeting too) so you never get "Nice to see you, Doug! · Welcome back, Doug"
 * side by side. The greeting stands alone only when there's nothing to ticker.
 *
 * Responsiveness: the banner is a single, never-wrapping 2.5rem line. The lead
 * (greeting/ticker) lives in a `min-w-0` zone that truncates so it can never
 * overflow; the CTAs are `shrink-0` so they always survive. "Chat to Doug" drops
 * below `sm` to keep the tight mobile line clean.
 */

/** The live-demo CTA — links to the same /try page the nav bell points at. */
function TryLink() {
  return (
    <Link
      href="/docs/client-side/try"
      className="shrink-0 rounded font-medium text-accent outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
    >
      Try it<span className="hidden sm:inline"> live</span>
      <span aria-hidden="true"> →</span>
    </Link>
  );
}

function ChatLink() {
  return (
    <a
      href={LINKEDIN_URL}
      target="_blank"
      rel="noreferrer"
      className="shrink-0 rounded font-medium text-white outline-none transition-colors hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
    >
      Chat to Doug
      <span aria-hidden="true"> →</span>
    </a>
  );
}

/** Trailing CTAs, shared by both banner states. "Chat to Doug" is sm+ only. */
function BannerCtas() {
  return (
    <span className="flex shrink-0 items-center gap-2">
      <span aria-hidden="true" className="text-white/25">
        ·
      </span>
      <TryLink />
      <span aria-hidden="true" className="hidden text-white/25 sm:inline">
        ·
      </span>
      <span className="hidden sm:inline">
        <ChatLink />
      </span>
    </span>
  );
}

/** Cold visitor / Hogsend not configured: the static notice + CTAs. */
function ColdBanner() {
  return (
    <span className="flex min-w-0 max-w-full items-center justify-center gap-2">
      <span className="min-w-0 truncate text-white/60">
        Hogsend is brand new.
      </span>
      <BannerCtas />
    </span>
  );
}

/** Opens the on-screen nav bell's feed. The lead is a button when live. */
function openFeed() {
  window.dispatchEvent(new CustomEvent(OPEN_FEED_EVENT));
}

function LiveBanner() {
  const { items } = useHogsendFeed(); // the same in_app feed the nav bell badges
  const [name, setName] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const prevLen = useRef(0);

  // The visitor's name follows them site-wide via localStorage (set by the demo).
  useEffect(() => {
    const read = () => setName(window.localStorage.getItem("hs-demo-name"));
    read();
    window.addEventListener("storage", read);
    return () => window.removeEventListener("storage", read);
  }, []);

  // A brand-new notification jumps to the front of the ticker (realtime).
  useEffect(() => {
    if (items.length > prevLen.current) setIdx(0);
    prevLen.current = items.length;
  }, [items.length]);

  // Rotate through recent notifications.
  useEffect(() => {
    if (items.length < 2) return;
    const t = window.setInterval(
      () => setIdx((i) => (i + 1) % items.length),
      4000,
    );
    return () => window.clearInterval(t);
  }, [items.length]);

  const greeting = name ? `Nice to see you, ${name}!` : null;
  const current = items.length ? items[idx % items.length] : null;

  // Nothing personal to say yet → the cold CTA.
  if (!greeting && !current) return <ColdBanner />;

  return (
    <span className="flex min-w-0 max-w-full items-center justify-center gap-2">
      {/*
       * Lead zone — a button that opens the bell. Truncates so it can never
       * push the CTAs off-screen. Shows the live notification when there is one,
       * otherwise the standalone greeting (never both — see the file header).
       */}
      <button
        type="button"
        onClick={openFeed}
        aria-label="Open notifications"
        className="flex min-w-0 items-center gap-1.5 rounded text-left outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-accent"
      >
        {current ? (
          <span className="flex min-w-0 items-center gap-1.5 text-white/55">
            <Bell
              className="size-3.5 shrink-0 text-accent"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <span key={current.id} className="hs-ticker-item min-w-0 truncate">
              {current.title}
            </span>
          </span>
        ) : (
          <span className="min-w-0 truncate font-medium text-white">
            {greeting} 👋
          </span>
        )}
      </button>
      <BannerCtas />
    </span>
  );
}

/**
 * SSR + the first client render emit the static cold banner so hydration matches;
 * after mount (and only when Hogsend is configured) we enhance to the live
 * ticker. Keeps the banner identical pre-launch / when the engine is unset.
 */
export function BannerTicker() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || !isHogsendConfigured) return <ColdBanner />;
  return <LiveBanner />;
}
