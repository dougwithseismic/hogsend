"use client";

import { HogsendProvider, ToastContainer } from "@hogsend/react";
import "@hogsend/react/styles.css";
// Loaded AFTER the package skin so our equal-specificity `.hsr` overrides win
// on source order — repaints the bell + feed into the crimzon dark brand.
import "./bell-theme.css";
import type { ReactNode } from "react";
import {
  HOGSEND_API_URL,
  HOGSEND_PUBLISHABLE_KEY,
  isHogsendConfigured,
} from "./config";
import { FeedToaster } from "./feed-toaster";

/**
 * Wraps the docs app in a Hogsend client (anonymous by default — docs visitors
 * aren't logged in). When Hogsend isn't configured yet, it's a pass-through so
 * the site renders identically. Dark color mode to match the brand.
 */
export function HogsendDocsProvider({ children }: { children: ReactNode }) {
  if (!isHogsendConfigured) return <>{children}</>;
  return (
    <HogsendProvider
      apiUrl={HOGSEND_API_URL}
      publishableKey={HOGSEND_PUBLISHABLE_KEY}
      colorMode="dark"
    >
      {children}
      {/* The live moment: a journey reaching the browser slides in a toast
          (top-right), driven by the REAL feed item landing — not the click. The
          bell stays the durable inbox. */}
      <ToastContainer placement="top-right" />
      <FeedToaster />
    </HogsendProvider>
  );
}
