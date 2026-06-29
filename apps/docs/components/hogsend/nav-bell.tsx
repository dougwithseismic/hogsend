"use client";

import { FeedPopover, NotificationBell, useHogsendFeed } from "@hogsend/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { isHogsendConfigured, OPEN_FEED_EVENT } from "./config";

const POPOVER_ID = "hs-docs-feed";

/**
 * The Hogsend notification bell + feed popover for the docs nav. Renders nothing
 * until Hogsend is configured (so the nav is unchanged pre-launch). Anonymous
 * visitors get their own feed; a demo journey `sendFeedItem`s into it.
 *
 * `badgeCountType="unread"` (not the default "unseen") is deliberate: the demo's
 * payoff is "your bell badged and the item is still unread" — "unseen" clears
 * the badge the moment the popover opens, before the visitor reads the item.
 * The empty state points back at the live demo so the bell is never a dead end.
 *
 * FEED: we render the package `<FeedPopover>` directly. Its `<NotificationFeed>`
 * now filters soft-archived rows itself and ships swipe-left-to-archive, so the
 * previous local `FeedPanel` drop-in is retired. Styling + positioning are
 * unchanged: FeedPopover renders the same `.hsr-popover` / `.hsr-feed*` shell
 * inside our fixed-anchor wrapper.
 *
 * PORTAL: fumadocs renders this bell inside the narrow, `overflow`-clipped left
 * sidebar. `<FeedPopover>` (`.hsr-popover`) is `position: absolute` (anchored to
 * its nearest positioned ancestor) with no portal of its own, so placed bare it
 * lands at the bottom of the sidebar scroll area and gets clipped. We anchor it
 * ourselves: a tiny `position: fixed` div pinned to the bell's rect, portaled to
 * `<body>` so it escapes the sidebar's overflow, with the popover opening
 * `bottom-start` (down and to the right, into the content area where there's
 * room). Follow-up: teach `@hogsend/react`'s FeedPopover to portal + anchor
 * itself so consumers don't have to. Recompute on scroll/resize while open.
 */
export function NavBell({
  align = "start",
}: {
  /**
   * Which edge of the bell the popover aligns to. "start" (docs left sidebar)
   * opens down-and-right; "end" (marketing top-right nav) opens down-and-left so
   * it stays on-screen.
   */
  align?: "start" | "end";
} = {}) {
  // Gate BEFORE any provider-dependent hook. When Hogsend isn't configured the
  // provider is a pass-through (no context), so the live bell — which calls
  // `useHogsendFeed` (and throws without a provider) — must not mount at all.
  // Renders nothing, leaving the nav unchanged pre-launch.
  if (!isHogsendConfigured) return null;
  return <NavBellLive align={align} />;
}

function NavBellLive({ align }: { align: "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [ringing, setRinging] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  );
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setMounted(true), []);

  // Ring the bell when a NEW item arrives. The badge alone is easy to miss, so
  // a genuine increase in the unread count swings the bell + pulses a halo (CSS
  // `.hs-docs-bell--ring`) for ~1s — the "something just happened" payoff the
  // live demo is selling. We track the previous count and only ring on a climb,
  // skipping the first observed value (initial fetch / hydration) so the bell is
  // calm on load. Re-applied per arrival (toggle off → on next frame) so a rapid
  // re-fire re-rings rather than sitting on a stale class.
  const { metadata } = useHogsendFeed();
  const unread = metadata.unread_count ?? 0;
  const prevUnread = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevUnread.current;
    prevUnread.current = unread;
    if (prev === null || unread <= prev) return;
    setRinging(false);
    const frame = requestAnimationFrame(() => setRinging(true));
    const done = window.setTimeout(() => setRinging(false), 1000);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(done);
    };
  }, [unread]);

  // Let the top banner ticker pop this feed open (clicking the live ticker opens
  // the bell). Only the on-screen bell reacts: a hidden instance (the other
  // responsive nav, a collapsed sidebar) has no `offsetParent`, so it stays put.
  useEffect(() => {
    const onOpen = (): void => {
      if (buttonRef.current?.offsetParent != null) setOpen(true);
    };
    window.addEventListener(OPEN_FEED_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_FEED_EVENT, onOpen);
  }, []);

  // Track the bell's viewport rect while the popover is open so the portaled
  // panel stays pinned to it through scroll/resize.
  useEffect(() => {
    if (!open) return;
    const update = (): void => {
      const r = buttonRef.current?.getBoundingClientRect();
      if (r)
        setAnchor({ top: r.bottom, left: align === "end" ? r.right : r.left });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, align]);

  return (
    <>
      <NotificationBell
        ref={buttonRef}
        isOpen={open}
        popoverId={POPOVER_ID}
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        className={cn("hs-docs-bell", ringing && "hs-docs-bell--ring")}
        badgeCountType="unread"
      />
      {mounted &&
        open &&
        anchor &&
        createPortal(
          <div
            style={{
              position: "fixed",
              top: anchor.top,
              left: anchor.left,
              zIndex: 1100,
            }}
          >
            <FeedPopover
              id={POPOVER_ID}
              isVisible={open}
              onClose={() => setOpen(false)}
              buttonRef={buttonRef}
              placement={align === "end" ? "bottom-end" : "bottom-start"}
              renderEmpty={() => (
                <div className="px-5 py-8 text-center">
                  <p className="text-sm text-white/55">No notifications yet.</p>
                  <p className="mt-1.5 text-[13px] text-white/35">
                    Try the live demo on the{" "}
                    <a
                      href="/docs/client-side/try"
                      className="text-accent hover:text-accent/80"
                    >
                      Client-side
                    </a>{" "}
                    page — fire an event and watch one land here.
                  </p>
                </div>
              )}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
