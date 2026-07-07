"use client";

import { createMemoryStorage } from "@hogsend/js";
import { HogsendProvider } from "@hogsend/react";
import "@hogsend/react/styles.css";
// Loaded AFTER the package skin so our equal-specificity `.hsr` overrides win
// on source order — repaints the bell + feed into the crimzon dark brand.
import "./bell-theme.css";
import { type ReactNode, useEffect, useState } from "react";
import { useSession } from "@/lib/auth-client";

export const HOGSEND_API_URL = process.env.NEXT_PUBLIC_HOGSEND_API_URL ?? "";
export const HOGSEND_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_HOGSEND_PUBLISHABLE_KEY ?? "";

/** False until the two NEXT_PUBLIC_HOGSEND_* env vars are set — the provider
 *  and bell render nothing, leaving the site unchanged pre-wiring. */
export const isHogsendConfigured = Boolean(
  HOGSEND_API_URL && HOGSEND_PUBLISHABLE_KEY,
);

/**
 * Mint the feed token AND resolve the recipient identity. The returned `userId`
 * is the contact's CANONICAL feed key (from /api/hogsend-token), NOT necessarily
 * the Better Auth id — a contact identified earlier keeps its own external_id.
 * The client must identify on this same key so the bell's read lands on the
 * contact journeys write to.
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

/**
 * The course's Hogsend client — the ENGINE-IDENTIFIED feed, not the docs
 * site's anonymous demo. A signed-in reader gets a server-minted userToken
 * from /api/hogsend-token (which also folds { email, userId } onto their
 * engine contact and resolves the canonical recipient key), so the bell polls
 * the same contact the course journeys `sendFeedItem` to. Until it lands (or
 * signed out) the client runs anonymous, which for this site is an empty feed.
 */
export function CourseHogsendProvider({ children }: { children: ReactNode }) {
  if (!isHogsendConfigured) return <>{children}</>;
  return <LiveProvider>{children}</LiveProvider>;
}

function LiveProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const sessionUserId = session?.user.id ?? null;
  const [identity, setIdentity] = useState<{
    token: string;
    userId: string;
  } | null>(null);

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
  // Memory-only storage: this site never persists `hs_anon_id`. Identity for
  // the feed is the server-minted userToken (signed-in), and an anonymous
  // visitor's feed is empty by design — so there is nothing a durable anon id
  // would add, and without it the site stores nothing beyond the sign-in
  // session cookie (no cookie banner needed; see /cookies).
  const [storage] = useState(createMemoryStorage);
  return (
    <HogsendProvider
      // HogsendProvider constructs its client ONCE (useState initializer) — the
      // identity that arrives later never reaches it and the re-identify effect
      // would 403. Keying on the resolved recipient key remounts the provider so
      // the client is CONSTRUCTED with { userId, userToken } (and flips back to
      // a fresh anon client on sign-out).
      key={identity ? `user:${identity.userId}` : "anon"}
      apiUrl={HOGSEND_API_URL}
      publishableKey={HOGSEND_PUBLISHABLE_KEY}
      colorMode="dark"
      // Falsy return = refresh failed; the SDK keeps the old token and the
      // next 403 retries. Never throws.
      onUserTokenExpiring={async () => (await fetchFeedIdentity())?.token ?? ""}
      storage={storage}
      {...identified}
    >
      {children}
    </HogsendProvider>
  );
}
