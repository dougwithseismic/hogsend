"use client";

import type { JSX } from "react";
import { openCookieSettings } from "./cookie-banner";

/**
 * The footer's re-entry point to the consent card (GDPR: withdrawing must be
 * as easy as granting). A button styled like the surrounding footer links —
 * it dispatches the reopen event the mounted CookieBanner listens for.
 */
export function CookieSettingsLink({
  className,
}: {
  className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={openCookieSettings}
      className={className ?? "transition-colors hover:text-white"}
    >
      Cookie settings
    </button>
  );
}
