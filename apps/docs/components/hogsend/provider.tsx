"use client";

import { HogsendProvider } from "@hogsend/react";
import "@hogsend/react/styles.css";
// Loaded AFTER the package skin so our equal-specificity `.hsr` overrides win
// on source order — repaints the bell + feed into the crimzon dark brand.
import "./bell-theme.css";
import { type ReactNode, useEffect, useState } from "react";
import { useSession } from "@/lib/auth-client";
import { createConsentGatedStorage } from "@/lib/consent-storage";
import {
  HOGSEND_API_URL,
  HOGSEND_PUBLISHABLE_KEY,
  isHogsendConfigured,
} from "./config";

/**
 * Wraps the docs app in a Hogsend client. A SIGNED-IN visitor (the shared
 * `*.hogsend.com` session) is ENGINE-IDENTIFIED: their Better Auth session mints
 * a server-side `userToken` (via /api/hogsend-token, which also folds
 * { email, userId, firstName } onto their contact), so the nav bell + the live
 * demo act on the ONE contact the journeys `sendFeedItem` to — and demo captures
 * carry `userId`, so a link.clicked resolves the same contact (no phantom twin).
 * Signed out (or Hogsend unconfigured) it runs anonymous, exactly as before.
 *
 * Storage stays consent-gated for the anonymous fallback: until the visitor
 * answers the cookie banner, `hs_anon_id` lives in memory only.
 */
export function HogsendDocsProvider({ children }: { children: ReactNode }) {
  if (!isHogsendConfigured) return <>{children}</>;
  return <LiveProvider>{children}</LiveProvider>;
}

async function fetchFeedToken(): Promise<string | null> {
  try {
    const res = await fetch("/api/hogsend-token", { method: "POST" });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: unknown };
    return typeof body.token === "string" ? body.token : null;
  } catch {
    return null;
  }
}

function LiveProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const userId = session?.user.id ?? null;
  const [token, setToken] = useState<string | null>(null);
  const [storage] = useState(createConsentGatedStorage);

  useEffect(() => {
    if (!userId) {
      setToken(null);
      return;
    }
    let alive = true;
    void fetchFeedToken().then((t) => {
      if (alive) setToken(t);
    });
    return () => {
      alive = false;
    };
  }, [userId]);

  const identified = userId && token ? { userId, userToken: token } : {};

  return (
    <HogsendProvider
      // HogsendProvider constructs its client ONCE (useState initializer), so a
      // userToken that arrives later never reaches it. Keying on the identity
      // pair remounts the provider once the token lands (and flips back to a
      // fresh anon client on sign-out).
      key={userId && token ? `user:${userId}` : "anon"}
      apiUrl={HOGSEND_API_URL}
      publishableKey={HOGSEND_PUBLISHABLE_KEY}
      colorMode="dark"
      // Falsy return = refresh failed; the SDK keeps the old token and the next
      // 403 retries. Never throws.
      onUserTokenExpiring={async () => (await fetchFeedToken()) ?? ""}
      storage={storage}
      {...identified}
    >
      {children}
    </HogsendProvider>
  );
}
