"use client";

/**
 * `useBanner(slot?)` — the v3 reactive banner hook. Binds to the banner-store
 * SLICE (`banners[slot]`) via `useStoreSelector`, derives the visible
 * (non-dismissed) array + `current` OUTSIDE the selector from the stable
 * `order`/`byId` pair (the infinite-loop guard, mirrors `useHogsendFeed`), and
 * delegates `dismiss`/`click` to the SDK banner client — so the `banner.*`
 * closed-loop emission lives in the client store mutation, not here.
 *
 * Realtime (poll default) is opened in an effect via `client.connect("banner:<slot>")`
 * and the initial `list()` fetch runs once per slot.
 */

import type { Banner, BannerClient, HogsendState, Store } from "@hogsend/js";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { HogsendContext } from "../provider/context.js";
import { useStoreSelector } from "./use-store.js";

const DEFAULT_SLOT = "default";
const EMPTY_ORDER: string[] = [];
const EMPTY_BY_ID: Record<string, Banner> = {};

/** Return shape of {@link useBanner}. */
export interface UseBanner {
  /** Visible (non-dismissed) banners for the slot, priority-ordered. */
  banners: Banner[];
  /** The highest-priority visible banner, else null. */
  current: Banner | null;
  /** Dismiss a banner (archive + `banner.dismissed`). */
  dismiss: (bannerId: string) => Promise<void>;
  /** Record a click (`banner.clicked`). */
  click: (bannerId: string) => Promise<void>;
  /** Whether the initial fetch is in flight. */
  loading: boolean;
  /** The reactive store (for advanced selectors). */
  store: Store<HogsendState>;
}

/** Build the visible array from a stable slice — NEVER inside a selector. */
function deriveBanners(
  order: string[],
  byId: Record<string, Banner>,
): Banner[] {
  const out: Banner[] = [];
  for (const id of order) {
    const b = byId[id];
    if (b && !b.dismissed) out.push(b);
  }
  return out;
}

/** The v3 banner hook. Must be used within `<HogsendProvider>`. */
export function useBanner(slot: string = DEFAULT_SLOT): UseBanner {
  const ctx = useContext(HogsendContext);
  if (!ctx) {
    throw new Error("useBanner must be used within <HogsendProvider>");
  }
  const client = ctx.client;

  // One banner client per slot (the SDK caches it → stable across renders).
  const banner: BannerClient = useMemo(
    () => client.banners(slot),
    [client, slot],
  );

  // ── reactive slice binding (stable references only) ──
  const order = useStoreSelector<HogsendState, string[]>(
    client.store,
    (s) => s.banners?.[slot]?.order ?? EMPTY_ORDER,
  );
  const byId = useStoreSelector<HogsendState, Record<string, Banner>>(
    client.store,
    (s) => s.banners?.[slot]?.byId ?? EMPTY_BY_ID,
  );

  const banners = useMemo(() => deriveBanners(order, byId), [order, byId]);
  const current = banners.length > 0 ? (banners[0] as Banner) : null;

  // ── initial fetch + realtime (poll) connect ──
  const [loading, setLoading] = useState(true);
  const didFetch = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    if (didFetch.current !== slot) {
      didFetch.current = slot;
      setLoading(true);
      banner
        .list()
        .then(() => {
          if (active) setLoading(false);
        })
        .catch(() => {
          if (active) setLoading(false);
        });
    }
    client.connect(`banner:${slot}`);
    return () => {
      active = false;
    };
  }, [client, banner, slot]);

  const dismiss = useCallback(
    (bannerId: string) => banner.dismiss(bannerId),
    [banner],
  );
  const click = useCallback(
    (bannerId: string) => banner.click(bannerId),
    [banner],
  );

  return {
    banners,
    current,
    dismiss,
    click,
    loading,
    store: client.store,
  };
}
