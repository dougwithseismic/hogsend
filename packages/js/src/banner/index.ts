/**
 * Banner client — v3. A banner is just a delivered feed item in a dedicated
 * per-slot category `banner:<slot>`, so this reuses the SAME recipient-scoped
 * read path (`GET /v1/feed?feedId=banner:<slot>`), the feed `/mark` route for
 * persistence, and the spine for the `banner.*` closed-loop events. No new
 * unscoped read path.
 *
 * EVENT-STORY DECISION: dismiss/click persist via the feed `/mark` route, whose
 * `inapp.item_archived`/`inapp.item_read` emits are INTERNAL feed-state
 * bookkeeping (keyed `inapp:banner:<slot>:<id>:<type>`, different idempotency
 * key, different namespace). The consumer-facing journey trigger is the
 * distinct-namespace `banner.dismissed` / `banner.clicked`, and `banner.shown`
 * (emitted by the React `<Banner>` on first render). Authors `trigger` on
 * `banner.*`, never on `inapp.*` for a `banner:*` feed. Suppressing `inapp.*`
 * for banner categories was rejected — it would mutate committed P3/P4 mark-route
 * behavior, violating the additive-only rule.
 */

import type { FeedItem } from "../feed/index.js";
import type { IdentityStore } from "../identity/identity-store.js";
import type { EventSpine } from "../spine/event-spine.js";
import type { Query, Transport } from "../spine/transport.js";
import type { Store } from "../store/external-store.js";
import type { BannerSliceState, HogsendState } from "../types.js";

/** A single on-site banner (a `banner:<slot>` feed item, projected). */
export interface Banner {
  id: string;
  slot: string;
  title: string | null;
  body: string | null;
  actionUrl: string | null;
  metadata: Record<string, unknown> | null;
  dismissed: boolean;
  createdAt: string;
}

/** The banner sub-client. */
export interface BannerClient {
  /** Eligible banners for the slot (newest first). */
  list(): Promise<Banner[]>;
  /** Highest-priority eligible (non-dismissed) banner, else null. */
  current(): Promise<Banner | null>;
  /** Record a click (`banner.clicked`) + optional mark-read. */
  click(bannerId: string): Promise<void>;
  /** Dismiss a banner (archive + `banner.dismissed`). */
  dismiss(bannerId: string): Promise<void>;
  /** Subscribe to banner-store changes for this slot. */
  on(listener: () => void): () => void;
  /** The reactive store the banner slice lives in. */
  readonly store: Store<HogsendState>;
}

/** Compose the feed category for a slot. `banner:<slot>`. */
export function bannerCategory(slot: string): string {
  return `banner:${slot}`;
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

interface ListResponse {
  items: FeedItem[];
}

/**
 * Identity params for a banner READ query / mark WRITE body — IDENTICAL to the
 * feed client's resolution (userToken when identified, else anonymousId). Do
 * NOT add a new unscoped path; banner reads are recipient-scoped server-side by
 * the same `resolveFeedRecipient`.
 */
function identityParams(identity: IdentityStore): Record<string, string> {
  const userToken = identity.getUserToken();
  const userId = identity.getUserId();
  if (userId && userToken) return { userToken };
  return { anonymousId: identity.getAnonymousId() };
}

/** Project a `banner:<slot>` feed item into a Banner. */
export function toBanner(item: FeedItem, slot: string): Banner {
  return {
    id: item.id,
    slot,
    title: item.title,
    body: item.body,
    actionUrl: item.actionUrl,
    metadata: item.metadata,
    dismissed: item.status === "archived",
    createdAt: item.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Banner-store slice (byId map + stable, priority-ordered id list)
// ---------------------------------------------------------------------------

function emptySlice(): BannerSliceState {
  return { byId: {}, order: [] };
}

/**
 * The banner-store: one slice per slot in the shared external store, with a
 * `byId` map for O(1) patches and a stable `order` array. React selects `order`
 * + `byId` (stable refs) and derives the visible (non-dismissed) array OUTSIDE
 * the selector (the infinite-loop guard), mirroring the feed-store.
 */
export function createBannerStore(store: Store<HogsendState>, slot: string) {
  const listeners = new Set<() => void>();

  function slice(): BannerSliceState {
    return store.getSnapshot().banners?.[slot] ?? emptySlice();
  }

  function write(next: BannerSliceState): void {
    store.setState((prev) => ({
      ...prev,
      banners: { ...prev.banners, [slot]: next },
    }));
  }

  function emit(): void {
    for (const l of listeners) l();
  }

  /** Priority/createdAt-desc order (metadata.priority wins, then newest). */
  function reorder(byId: Record<string, Banner>): string[] {
    return Object.values(byId)
      .sort((a, b) => {
        const pa = Number((a.metadata?.priority as number) ?? 0);
        const pb = Number((b.metadata?.priority as number) ?? 0);
        if (pa !== pb) return pb - pa;
        return a.createdAt < b.createdAt ? 1 : -1;
      })
      .map((b) => b.id);
  }

  return {
    setList(banners: Banner[]): void {
      const byId: Record<string, Banner> = {};
      for (const b of banners) byId[b.id] = b;
      write({ byId, order: reorder(byId) });
      emit();
    },
    /** Upsert realtime/poll banners (merge). */
    upsert(banners: Banner[]): void {
      if (banners.length === 0) return;
      const cur = slice();
      const byId = { ...cur.byId };
      let changed = false;
      for (const b of banners) {
        if (byId[b.id] !== b) changed = true;
        byId[b.id] = b;
      }
      if (!changed) return;
      write({ byId, order: reorder(byId) });
      emit();
    },
    patch(id: string, partial: Partial<Banner>): void {
      const cur = slice();
      const existing = cur.byId[id];
      if (!existing) return;
      const byId = { ...cur.byId, [id]: { ...existing, ...partial } };
      write({ byId, order: cur.order });
      emit();
    },
    on(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type BannerStore = ReturnType<typeof createBannerStore>;

// ---------------------------------------------------------------------------
// Banner client
// ---------------------------------------------------------------------------

export interface BannerClientOptions {
  slot: string;
  transport: Transport;
  spine: EventSpine;
  identity: IdentityStore;
  store: Store<HogsendState>;
  bannerStore: BannerStore;
  /** Emit `inapp.item_read` mark on click (default true). */
  markReadOnClick?: boolean;
}

/** Build the banner client over a shared banner-store slice. */
export function createBannerClient(opts: BannerClientOptions): BannerClient {
  const { slot, transport, spine, identity, store, bannerStore } = opts;
  const feedId = bannerCategory(slot);
  const markReadOnClick = opts.markReadOnClick ?? true;

  async function list(): Promise<Banner[]> {
    const query: Query = {
      feedId,
      status: "all",
      ...identityParams(identity),
    };
    const res = await transport.get<ListResponse>("/v1/feed", query);
    const banners = res.items.map((i) => toBanner(i, slot));
    bannerStore.setList(banners);
    return banners;
  }

  async function current(): Promise<Banner | null> {
    const banners = await list();
    return banners.find((b) => !b.dismissed) ?? null;
  }

  async function dismiss(bannerId: string): Promise<void> {
    // (a) optimistic store patch
    bannerStore.patch(bannerId, { dismissed: true });
    // (b) persist via the feed mark route (state archived). The route's
    // `inapp.item_archived` emit is internal bookkeeping (see module note).
    await transport.post("/v1/feed/mark", {
      ids: [bannerId],
      state: "archived",
      feedId,
      ...identityParams(identity),
    });
    // (c) the consumer-facing journey trigger.
    await spine.capture("banner.dismissed", { slot, bannerId });
  }

  async function click(bannerId: string): Promise<void> {
    const actionUrl =
      store.getSnapshot().banners?.[slot]?.byId[bannerId]?.actionUrl ?? null;
    await spine.capture("banner.clicked", {
      slot,
      bannerId,
      ...(actionUrl ? { actionUrl } : {}),
    });
    if (markReadOnClick) {
      // Best-effort mark-read; failure must not block the click trigger.
      try {
        await transport.post("/v1/feed/mark", {
          ids: [bannerId],
          state: "read",
          feedId,
          ...identityParams(identity),
        });
      } catch {
        // ignore — the click event already fired.
      }
    }
  }

  return {
    list,
    current,
    click,
    dismiss,
    on: (listener) => bannerStore.on(listener),
    store,
  };
}
