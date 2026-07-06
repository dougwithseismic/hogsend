"use client";

import { Bell } from "lucide-react";
import type { JSX } from "react";
import {
  isHogsendConfigured,
  OPEN_FEED_EVENT,
} from "@/components/hogsend/config";

/**
 * "Open the bell" — pops the REAL nav bell's feed open, exactly the way the
 * top banner ticker does (dispatches OPEN_FEED_EVENT; the on-screen NavBell
 * catches it). The page points UP at the bell; this button proves it's live.
 * Renders nothing when Hogsend isn't configured, matching the bell itself.
 */
export function OpenBellButton(): JSX.Element | null {
  if (!isHogsendConfigured) return null;
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN_FEED_EVENT))}
      className="inline-flex h-12 items-center gap-2.5 rounded-[10px] border border-white/25 px-5 font-medium text-base text-white tracking-[-0.02em] transition-colors hover:bg-white/[0.06]"
    >
      <Bell className="size-4" strokeWidth={1.5} aria-hidden="true" />
      Open the bell
      <span aria-hidden="true" className="text-white/40">
        ↑
      </span>
    </button>
  );
}
