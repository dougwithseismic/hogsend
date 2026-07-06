"use client";

import { HogsendProvider } from "@hogsend/react";
import "@hogsend/react/styles.css";
// Loaded AFTER the package skin so our equal-specificity `.hsr` overrides win
// on source order — repaints the bell + feed into the crimzon dark brand.
import "./bell-theme.css";
import { type ReactNode, useState } from "react";
import { createConsentGatedStorage } from "@/lib/consent-storage";
import {
  HOGSEND_API_URL,
  HOGSEND_PUBLISHABLE_KEY,
  isHogsendConfigured,
} from "./config";

/**
 * Wraps the docs app in a Hogsend client (anonymous by default — docs visitors
 * aren't logged in). When Hogsend isn't configured yet, it's a pass-through so
 * the site renders identically. Dark color mode to match the brand.
 *
 * Storage is consent-gated: until the visitor answers the cookie banner (or
 * the EmailCapture terms checkbox), `hs_anon_id` lives in memory only — the
 * same cookieless-until-consent rule PostHog follows on this site. The
 * adapter listens for the consent flip itself, so no remount is needed.
 */
export function HogsendDocsProvider({ children }: { children: ReactNode }) {
  const [storage] = useState(createConsentGatedStorage);
  if (!isHogsendConfigured) return <>{children}</>;
  return (
    <HogsendProvider
      apiUrl={HOGSEND_API_URL}
      publishableKey={HOGSEND_PUBLISHABLE_KEY}
      colorMode="dark"
      storage={storage}
    >
      {children}
    </HogsendProvider>
  );
}
