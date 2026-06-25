"use client";

import { FeedPopover, NotificationBell } from "@hogsend/react";
import { useRef, useState } from "react";
import { isHogsendConfigured } from "./config";

const POPOVER_ID = "hs-docs-feed";

/**
 * The Hogsend notification bell + feed popover for the docs top nav. Renders
 * nothing until Hogsend is configured (so the nav is unchanged pre-launch).
 * Anonymous visitors get their own feed; a demo journey `sendFeedItem`s into it.
 *
 * `badgeCountType="unread"` (not the default "unseen") is deliberate: the demo's
 * payoff is "your bell badged and the item is still unread" — "unseen" clears
 * the badge the moment the popover opens, before the visitor reads the item.
 * The empty state points back at the live demo so the bell is never a dead end.
 */
export function NavBell() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

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
      <FeedPopover
        id={POPOVER_ID}
        isVisible={open}
        onClose={() => setOpen(false)}
        buttonRef={buttonRef}
        placement="bottom-end"
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
    </>
  );
}
