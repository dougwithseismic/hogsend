"use client";

import { useHogsendFeed, useToast } from "@hogsend/react";
import { useEffect, useRef } from "react";

/**
 * The feed → toast bridge. Watches the SAME `in_app` feed the nav bell badges and
 * fires a prominent toast the instant a genuinely-new item arrives — so a
 * journey reaching back into the browser is an unmissable on-screen moment, not a
 * silent badge on a hidden sidebar icon. The bell stays the durable inbox; the
 * toast is the live "it just happened to me" beat.
 *
 * HONEST GATING (this matters for our dev ICP): the toast fires off the REAL
 * server item landing in the feed — never optimistically on click. Open devtools
 * and you'll see the round trip; the toast is the truthful echo of `sendFeedItem`.
 *
 * Exactly-once per item id: seed the seen-set silently on the first ready
 * snapshot (so a reload never replays a returning visitor's existing items as
 * toasts), then toast only ids not seen before.
 */
export function FeedToaster() {
  const { show } = useToast();
  const { items, loading } = useHogsendFeed(); // default "in_app" — the bell's feed
  const seen = useRef<Set<string>>(new Set());
  const primed = useRef(false);

  useEffect(() => {
    if (loading) return; // wait for the first real fetch
    if (!primed.current) {
      for (const it of items) seen.current.add(it.id);
      primed.current = true;
      return;
    }
    for (const it of items) {
      if (seen.current.has(it.id)) continue;
      seen.current.add(it.id);
      show({
        id: it.id, // upsert-by-id collapses any double-fire (StrictMode/poll race)
        type: it.type ?? "welcome",
        title: it.title ?? "New notification",
        body: it.body ?? null,
        actionUrl: it.actionUrl ?? null,
        metadata: it.metadata ?? null,
        duration: 8000,
      });
    }
  }, [items, loading, show]);

  return null;
}
