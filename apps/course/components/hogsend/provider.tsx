"use client";

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

/**
 * The course's Hogsend client — the ENGINE-IDENTIFIED feed, not the docs
 * site's anonymous demo. A signed-in reader gets a server-minted userToken
 * from /api/hogsend-token (which also folds { email, userId } onto their
 * engine contact), so the bell polls the same contact the course journeys
 * `sendFeedItem` to. Until the token lands (or signed out) the client runs
 * anonymous, which for this site simply means an empty feed.
 */
export function CourseHogsendProvider({ children }: { children: ReactNode }) {
  if (!isHogsendConfigured) return <>{children}</>;
  return <LiveProvider>{children}</LiveProvider>;
}

function LiveProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const userId = session?.user.id ?? null;
  const [token, setToken] = useState<string | null>(null);

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
      // HogsendProvider constructs its client ONCE (useState initializer) — a
      // userToken that arrives later never reaches it and the re-identify
      // effect would 403. Keying on the identity pair remounts the provider
      // so the client is CONSTRUCTED with { userId, userToken } (and flips
      // back to a fresh anon client on sign-out).
      key={userId && token ? `user:${userId}` : "anon"}
      apiUrl={HOGSEND_API_URL}
      publishableKey={HOGSEND_PUBLISHABLE_KEY}
      colorMode="dark"
      // Falsy return = refresh failed; the SDK keeps the old token and the
      // next 403 retries. Never throws.
      onUserTokenExpiring={async () => (await fetchFeedToken()) ?? ""}
      {...identified}
    >
      {children}
    </HogsendProvider>
  );
}
