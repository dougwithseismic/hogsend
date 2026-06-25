"use client";

import { useHogsendFeed } from "@hogsend/react";
import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isHogsendConfigured } from "@/components/hogsend/config";
import { LINKEDIN_URL } from "@/lib/site";

/**
 * The top announcement banner, emboldened with the feed. For a cold visitor it's
 * the classic "Hogsend is brand new — Chat to Doug" CTA. Once we know the
 * visitor (a name they typed in the live demo, stored site-wide) it greets them
 * — "Nice to see you, {name}!" — and tickers their REAL in-app notifications in
 * realtime: a new item (a journey reaching their browser) jumps to the front.
 * The bell in the nav is the durable inbox; this is the ambient pulse.
 */

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

/** Cold visitor / Hogsend not configured: the original static notice. */
function ColdBanner() {
  return (
    <>
      <span className="text-white/60">Hogsend is brand new.</span>
      <ChatLink />
    </>
  );
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
    <span className="flex min-w-0 items-center gap-2">
      {greeting && (
        <span className="shrink-0 font-medium text-white">{greeting} 👋</span>
      )}
      {current && (
        <>
          {greeting && (
            <span aria-hidden="true" className="shrink-0 text-white/25">
              ·
            </span>
          )}
          <span className="inline-flex min-w-0 items-center gap-1.5 text-white/55">
            <Bell
              className="size-3.5 shrink-0 text-accent"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <span key={current.id} className="hs-ticker-item truncate">
              {current.title}
            </span>
          </span>
        </>
      )}
      <span
        aria-hidden="true"
        className="hidden shrink-0 text-white/25 sm:inline"
      >
        ·
      </span>
      <span className="hidden shrink-0 sm:inline">
        <ChatLink />
      </span>
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
