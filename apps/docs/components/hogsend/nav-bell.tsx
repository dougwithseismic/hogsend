"use client";

import { FeedPopover, NotificationBell } from "@hogsend/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isHogsendConfigured } from "./config";

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
 * PORTAL: fumadocs renders this bell inside the narrow, `overflow`-clipped left
 * sidebar. `<FeedPopover>` is `position: absolute` (anchored to its nearest
 * positioned ancestor) with no portal, so placed bare it lands at the bottom of
 * the sidebar scroll area and gets clipped. We anchor it ourselves: a tiny
 * `position: fixed` div pinned to the bell's rect, portaled to `<body>` so it
 * escapes the sidebar's overflow, with the popover opening `bottom-start` (down
 * and to the right, into the content area where there's room). Follow-up: teach
 * `@hogsend/react`'s FeedPopover to portal + anchor itself so consumers don't
 * have to. Recompute on scroll/resize while open.
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
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  );
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setMounted(true), []);

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

  if (!isHogsendConfigured) return null;

  return (
    <>
      <NotificationBell
        ref={buttonRef}
        isOpen={open}
        popoverId={POPOVER_ID}
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        className="hs-docs-bell"
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
