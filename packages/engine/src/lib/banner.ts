import type { FeedBlock } from "@hogsend/db";
import { type SendFeedItemResult, sendFeedItem } from "./feed.js";

/**
 * The banner-category prefix. A banner is just a delivered feed item in a
 * dedicated, per-slot category `banner:<slot>` (NOT the default `in_app` feed),
 * so banners never pollute the notification bell and map onto the SAME
 * recipient-scoped read path (`GET /v1/feed?feedId=banner:<slot>`).
 */
export const BANNER_CATEGORY_PREFIX = "banner:";

/**
 * Compose the feed category for a banner slot. `banner:<slot>`.
 */
export function bannerCategory(slot: string): string {
  return `${BANNER_CATEGORY_PREFIX}${slot}`;
}

export interface SendBannerOptions {
  recipient: { userId?: string; email?: string; anonymousId?: string };
  /** Banner placement slot (e.g. `"top"`, `"billing"`). Maps to category `banner:<slot>`. */
  slot: string;
  title?: string;
  body?: string;
  blocks?: FeedBlock[];
  actionUrl?: string;
  metadata?: Record<string, unknown>;
  templateKey?: string;
  journeyStateId?: string;
  /** Explicit idempotency key — wins over journey auto-derivation. */
  idempotencyKey?: string;
  /** Disambiguates the exactly-once key across divergent branches. */
  idempotencyLabel?: string;
}

export type SendBannerResult = SendFeedItemResult;

/**
 * Journey-callable on-site banner send — a thin wrapper over {@link sendFeedItem}
 * that pins `type: "banner"` and `category: "banner:<slot>"`. It inherits feed
 * recipient resolution, `in_app` suppression, replay-safe idempotency, and the
 * Redis `feed:<recipientKey>` realtime publish (so banners are realtime too).
 *
 * The dedicated `banner:<slot>` category keeps banners out of the default
 * `in_app` notification feed. The browser reads them via
 * `GET /v1/feed?feedId=banner:<slot>` (the existing route category-filters and
 * recipient-scopes server-side — no new read path).
 *
 * Event story: dismiss/click persist via the feed `/mark` route, whose
 * `inapp.*` emits are INTERNAL feed-state bookkeeping. The consumer-facing
 * journey trigger is the distinct-namespace `banner.dismissed` / `banner.clicked`
 * / `banner.shown` the SDK emits client-side.
 */
export async function sendBanner(
  opts: SendBannerOptions,
): Promise<SendBannerResult> {
  return sendFeedItem({
    recipient: opts.recipient,
    type: "banner",
    category: bannerCategory(opts.slot),
    title: opts.title,
    body: opts.body,
    blocks: opts.blocks,
    actionUrl: opts.actionUrl,
    metadata: opts.metadata,
    templateKey: opts.templateKey,
    journeyStateId: opts.journeyStateId,
    idempotencyKey: opts.idempotencyKey,
    idempotencyLabel: opts.idempotencyLabel,
  });
}
