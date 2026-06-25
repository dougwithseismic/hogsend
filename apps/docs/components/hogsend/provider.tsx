"use client";

import { HogsendProvider } from "@hogsend/react";
import "@hogsend/react/styles.css";
import type { ReactNode } from "react";
import {
  HOGSEND_API_URL,
  HOGSEND_PUBLISHABLE_KEY,
  isHogsendConfigured,
} from "./config";

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
    </HogsendProvider>
  );
}
