"use client";

import { FeedPopover, NotificationBell } from "@hogsend/react";
import { useRef, useState } from "react";
import { isHogsendConfigured } from "./config";

const POPOVER_ID = "hs-docs-feed";

/**
 * The Hogsend notification bell + feed popover for the docs top nav. Renders
 * nothing until Hogsend is configured (so the nav is unchanged pre-launch).
 * Anonymous visitors get their own feed; a journey `sendFeedItem`s into it.
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
      />
      <FeedPopover
        id={POPOVER_ID}
        isVisible={open}
        onClose={() => setOpen(false)}
        buttonRef={buttonRef}
        placement="bottom-end"
      />
    </>
  );
}
