import { randomUUID } from "node:crypto";
import { type Database, links, trackedLinks } from "@hogsend/db";

/**
 * The channel-agnostic MANAGED tracked-link mint — the counterpart to the email
 * HTML-rewrite path (`prepareTrackedHtml`). Any non-email channel (the Studio
 * Links UI, a Discord DM/channel post, SMS, a share link) mints through here.
 *
 * It inserts a durable `links` row (the operator/campaign identity that the
 * Studio lists + manages) plus a `tracked_links` click-counter row pointing back
 * at it, and returns the `/v1/t/c/:id` redirect URL. Email does NOT use this — it
 * rewrites HTML at send time and keeps `tracked_links.link_id` NULL, so the two
 * remain independent consumers of the same click spine.
 *
 * SHARE-SAFE INVARIANT: a link is identity-bearing (carries a `distinctId` the
 * click can stitch + may mint a single-use `hs_t`) ONLY when `type: "personal"`
 * AND an explicit `distinctId` is passed. A `"public"` link NEVER carries a
 * person token — a shared/reshared public link attributes by campaign only.
 */
export type LinkType = "personal" | "public";

export interface MintLinkOptions {
  db: Database;
  /** The destination URL the redirect 302s to. Must be http(s). */
  url: string;
  /** Public base URL of this instance (the tracking host) — the redirect prefix. */
  baseUrl: string;
  /** Originating channel: "studio" | "discord" | "sms" | "referral" | … (open). */
  source: string;
  /** "personal" (1:1, identity-bearing) | "public" (shareable). Default "public". */
  type?: LinkType;
  /** Operator-facing name (Studio list). */
  label?: string;
  /** UTM-style campaign grouping (public links). */
  campaign?: string;
  /**
   * The canonical contact key a click should stitch — honoured ONLY for
   * `type: "personal"`; dropped for public links (the share-safe invariant).
   */
  distinctId?: string;
  /** The admin actor who minted it (Studio). */
  createdBy?: string;
}

export interface MintedLink {
  /** The `links` row id (the managed identity). */
  linkId: string;
  /** The `tracked_links` row id — the `:id` in the redirect URL. */
  trackedLinkId: string;
  /** The short redirect URL: `${baseUrl}/v1/t/c/:id`. */
  url: string;
}

/**
 * Reject a non-http(s) destination at mint time. The click route 302s to the
 * stored URL verbatim, so giving operators a UI to mint these would otherwise
 * widen the latent open-redirect into `javascript:`/`data:` territory.
 */
function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`mintLink: invalid destination URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `mintLink: destination must be http(s), got "${parsed.protocol}"`,
    );
  }
}

export async function mintLink(opts: MintLinkOptions): Promise<MintedLink> {
  assertHttpUrl(opts.url);
  const type: LinkType = opts.type ?? "public";
  // A public link must NEVER carry a person token — drop any distinctId.
  const distinctId = type === "personal" ? (opts.distinctId ?? null) : null;

  const linkId = randomUUID();
  const trackedLinkId = randomUUID();

  await opts.db.insert(links).values({
    id: linkId,
    originalUrl: opts.url,
    type,
    label: opts.label ?? null,
    campaign: opts.campaign ?? null,
    source: opts.source,
    distinctId,
    createdBy: opts.createdBy ?? null,
  });
  await opts.db.insert(trackedLinks).values({
    id: trackedLinkId,
    linkId,
    emailSendId: null,
    distinctId,
    source: opts.source,
    originalUrl: opts.url,
  });

  return {
    linkId,
    trackedLinkId,
    url: `${opts.baseUrl}/v1/t/c/${trackedLinkId}`,
  };
}
