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

/**
 * Mint the feed token AND resolve the recipient identity. The returned `userId`
 * is the contact's CANONICAL feed key (from /api/hogsend-token), NOT necessarily
 * the Better Auth id — a contact identified earlier keeps its own external_id.
 * The client must identify + capture on this same key so writes and the bell's
 * reads land on one contact.
 */
async function fetchFeedIdentity(): Promise<{
  token: string;
  userId: string;
} | null> {
  try {
    const res = await fetch("/api/hogsend-token", { method: "POST" });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: unknown; userId?: unknown };
    if (typeof body.token !== "string" || typeof body.userId !== "string") {
      return null;
    }
    return { token: body.token, userId: body.userId };
  } catch {
    return null;
  }
}

function LiveProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const sessionUserId = session?.user.id ?? null;
  const [identity, setIdentity] = useState<{
    token: string;
    userId: string;
  } | null>(null);
  const [storage] = useState(createConsentGatedStorage);

  useEffect(() => {
    if (!sessionUserId) {
      setIdentity(null);
      return;
    }
    let alive = true;
    void fetchFeedIdentity().then((r) => {
      if (alive) setIdentity(r);
    });
    return () => {
      alive = false;
    };
  }, [sessionUserId]);

  const identified = identity
    ? { userId: identity.userId, userToken: identity.token }
    : {};

  return (
    <HogsendProvider
      // HogsendProvider constructs its client ONCE (useState initializer), so the
      // identity that arrives later never reaches it. Keying on the resolved
      // recipient key remounts the provider once it lands (and flips back to a
      // fresh anon client on sign-out).
      key={identity ? `user:${identity.userId}` : "anon"}
      apiUrl={HOGSEND_API_URL}
      publishableKey={HOGSEND_PUBLISHABLE_KEY}
      colorMode="dark"
      // Falsy return = refresh failed; the SDK keeps the old token and the next
      // 403 retries. Never throws.
      onUserTokenExpiring={async () => (await fetchFeedIdentity())?.token ?? ""}
      storage={storage}
      {...identified}
    >
      {children}
    </HogsendProvider>
  );
}
