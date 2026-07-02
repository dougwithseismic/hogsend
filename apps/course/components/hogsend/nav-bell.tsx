"use client";

import { FeedPopover, NotificationBell, useHogsendFeed } from "@hogsend/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSession } from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import { isHogsendConfigured } from "./provider";

const POPOVER_ID = "hs-course-feed";

/**
 * The course nav's notification bell + feed popover — the reader's IDENTIFIED
 * feed (course journeys `sendFeedItem` to their contact: welcome, new
 * chapters, gift claimed, …). Renders nothing until Hogsend is configured AND
 * the reader is signed in: an anonymous course visitor has no feed worth a
 * bell. Adapted from the docs NavBell (same portal-anchor technique so the
 * popover escapes any overflow clipping; same ring-on-new-unread payoff).
 */
export function NavBell({
  align = "end",
}: {
  /** Which edge of the bell the popover aligns to; the course nav mounts it
   *  top-right, so "end" (down-and-left) is the default. */
  align?: "start" | "end";
} = {}) {
  const { data: session } = useSession();
  // Gate BEFORE any provider-dependent hook: unconfigured → no context, and
  // `useHogsendFeed` throws without a provider.
  if (!isHogsendConfigured || !session) return null;
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

  // Ring on a genuine unread climb (skip the first observed value so the bell
  // is calm on load) — the "something just happened" moment.
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

  // Track the bell's viewport rect while open so the portaled panel stays
  // pinned through scroll/resize.
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
                    Course updates land here — new chapters, gift claims, and
                    your milestones.
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
