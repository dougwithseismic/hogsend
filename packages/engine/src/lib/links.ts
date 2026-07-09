import { randomUUID } from "node:crypto";
import { type Database, links, trackedLinks } from "@hogsend/db";
import { isNull, ne, or } from "drizzle-orm";

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
  /**
   * Optional vanity slug — the `/l/:slug` short path layered over the UUID
   * redirect. Normalized lowercase; unique per instance (SlugTakenError on
   * conflict). Managed links only — email's per-send links stay UUID.
   */
  slug?: string;
}

export interface MintedLink {
  /** The `links` row id (the managed identity). */
  linkId: string;
  /** The `tracked_links` row id — the `:id` in the redirect URL. */
  trackedLinkId: string;
  /** The short redirect URL: `${baseUrl}/v1/t/c/:id`. */
  url: string;
  /** The normalized vanity slug, if one was minted. */
  slug: string | null;
  /** The vanity short URL (`${baseUrl}/l/:slug`), if a slug was minted. */
  vanityUrl: string | null;
}

// ---------------------------------------------------------------------------
// Vanity slugs
// ---------------------------------------------------------------------------

/** 1–64 chars of lowercase [a-z0-9-], no leading/trailing hyphen. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Thrown when a requested slug is already held by another link → HTTP 409. */
export class SlugTakenError extends Error {
  constructor(slug: string) {
    super(`Slug "${slug}" is already taken`);
    this.name = "SlugTakenError";
  }
}

/**
 * Lowercase-normalize + validate a requested vanity slug. Throws on an
 * invalid shape (→ HTTP 400). Case-insensitivity comes from normalizing at
 * every write — the DB unique index then only ever sees lowercase.
 */
export function normalizeSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid slug "${raw}": 1-64 lowercase letters/digits/hyphens, no leading/trailing hyphen`,
    );
  }
  return slug;
}

/**
 * True when a DB error is the Postgres unique_violation on the slug index.
 * Walks the cause chain — drizzle wraps the driver's PostgresError in a
 * DrizzleQueryError whose `cause` carries the actual code/constraint.
 */
export function isSlugUniqueViolation(err: unknown): boolean {
  for (let e = err, depth = 0; e && depth < 5; depth++) {
    const candidate = e as {
      code?: string;
      constraint_name?: string;
      message?: string;
      cause?: unknown;
    };
    if (
      candidate.code === "23505" &&
      (candidate.constraint_name === "links_slug_unique" ||
        (candidate.message?.includes("links_slug_unique") ?? false))
    ) {
      return true;
    }
    e = candidate.cause;
  }
  return false;
}

export function vanityUrlFor(baseUrl: string, slug: string): string {
  return `${baseUrl}/l/${slug}`;
}

/** The `tracked_links.source` marker of a link's per-link QR scan row. */
export const QR_TRACKED_SOURCE = "qr";

/**
 * SQL predicate selecting a link's CANONICAL tracked row — the redirect row
 * minted alongside the link, as opposed to the lazily-minted per-link QR scan
 * row (`source = 'qr'`). The ONE definition of "which tracked row is the
 * link's redirect row"; every consumer (vanity resolver, admin aggregates)
 * must use it rather than re-deriving QR-awareness.
 */
export function canonicalTrackedRowFilter() {
  return or(
    isNull(trackedLinks.source),
    ne(trackedLinks.source, QR_TRACKED_SOURCE),
  );
}

/**
 * Reject a non-http(s) destination at mint time. The click route 302s to the
 * stored URL verbatim, so giving operators a UI to mint these would otherwise
 * widen the latent open-redirect into `javascript:`/`data:` territory.
 */
export function assertHttpUrl(url: string): void {
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
  const slug = opts.slug !== undefined ? normalizeSlug(opts.slug) : null;

  const linkId = randomUUID();
  const trackedLinkId = randomUUID();

  try {
    await opts.db.insert(links).values({
      id: linkId,
      originalUrl: opts.url,
      type,
      slug,
      label: opts.label ?? null,
      campaign: opts.campaign ?? null,
      source: opts.source,
      distinctId,
      createdBy: opts.createdBy ?? null,
    });
  } catch (err) {
    if (slug && isSlugUniqueViolation(err)) throw new SlugTakenError(slug);
    throw err;
  }
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
    slug,
    vanityUrl: slug ? vanityUrlFor(opts.baseUrl, slug) : null,
  };
}
