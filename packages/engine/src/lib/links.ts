import { randomUUID } from "node:crypto";
import { type Database, links, trackedLinks } from "@hogsend/db";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";

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
  /**
   * Longer operator note — what/where this link or its printed QR actually is
   * ("sticker on the workshop door"), for telling codes apart in bulk.
   */
  description?: string;
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
  /**
   * Arrival attribution opt-in: append `hs_ref=<click id>` to every redirect
   * from this link so the landing page can report the visitor back to
   * `POST /v1/t/arrive`. Off by default — an appended param breaks strict
   * OAuth redirect_uri destinations.
   */
  appendRef?: boolean;
  /**
   * Idempotent-mint key for slugless links: re-minting with the same key +
   * same destination returns the EXISTING link (`existing: true`) instead of
   * a duplicate; same key + different destination is an
   * IdempotencyConflictError (→ 409). Unique among LIVE links only (partial
   * index) — archiving frees the key. Mutually exclusive with `slug` (a slug
   * IS an idempotency key: same slug + same url + same type recovers too).
   */
  idempotencyKey?: string;
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
  /**
   * True when the mint RECOVERED an existing live link (same slug or
   * idempotencyKey + same destination) instead of inserting a new one.
   */
  existing: boolean;
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
 * True when a DB error is the Postgres unique_violation on the named
 * constraint. Walks the cause chain — drizzle wraps the driver's
 * PostgresError in a DrizzleQueryError whose `cause` carries the actual
 * code/constraint.
 */
function isUniqueViolationOn(err: unknown, constraint: string): boolean {
  for (let e = err, depth = 0; e && depth < 5; depth++) {
    const candidate = e as {
      code?: string;
      constraint_name?: string;
      message?: string;
      cause?: unknown;
    };
    if (
      candidate.code === "23505" &&
      (candidate.constraint_name === constraint ||
        (candidate.message?.includes(constraint) ?? false))
    ) {
      return true;
    }
    e = candidate.cause;
  }
  return false;
}

/** True when a DB error is the unique_violation on the slug index. */
export function isSlugUniqueViolation(err: unknown): boolean {
  return isUniqueViolationOn(err, "links_slug_unique");
}

/**
 * True when a DB error is the unique_violation on the partial (live-rows-only)
 * idempotency-key index.
 */
export function isIdempotencyKeyViolation(err: unknown): boolean {
  return isUniqueViolationOn(err, "links_idempotency_key_unique");
}

/**
 * Thrown when an idempotencyKey is already held by a LIVE link with a
 * DIFFERENT destination → HTTP 409. (Same destination is not a conflict — it
 * recovers the existing link.)
 */
export class IdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`Idempotency key "${key}" already used for a different destination`);
    this.name = "IdempotencyConflictError";
  }
}

export function vanityUrlFor(baseUrl: string, slug: string): string {
  return `${baseUrl}/l/${slug}`;
}

/** The `tracked_links.source` marker of a link's per-link QR scan row. */
export const QR_TRACKED_SOURCE = "qr";

/**
 * Lazily mint (or fetch) a managed link's QR scan row — the SECOND
 * `tracked_links` row for the link, `source: "qr"`. The QR code encodes
 * `/v1/t/c/<this row>` (the durable UID URL, never the slug), so scans are
 * attributable separately from link clicks while a PATCH re-target (which
 * updates every tracked row scoped by `link_id`) keeps a printed code
 * pointing at the current destination.
 *
 * Race-safe via the partial unique index `tracked_links(link_id) WHERE
 * source = 'qr'`: a concurrent double-mint loses the insert cleanly and
 * re-reads the winner's row. Returns null when the link doesn't exist.
 */
export async function ensureQrTrackedLink(opts: {
  db: Database;
  linkId: string;
}): Promise<{ trackedLinkId: string; created: boolean } | null> {
  const { db, linkId } = opts;

  const qrRowFilter = and(
    eq(trackedLinks.linkId, linkId),
    eq(trackedLinks.source, QR_TRACKED_SOURCE),
  );

  const [existing] = await db
    .select({ id: trackedLinks.id })
    .from(trackedLinks)
    .where(qrRowFilter)
    .limit(1);
  if (existing) return { trackedLinkId: existing.id, created: false };

  const [link] = await db
    .select({
      originalUrl: links.originalUrl,
      distinctId: links.distinctId,
    })
    .from(links)
    .where(eq(links.id, linkId))
    .limit(1);
  if (!link) return null;

  // distinctId copied from the link so a PERSONAL link's scans stitch the same
  // subject as its clicks; public links stay identity-free (NULL).
  const [inserted] = await db
    .insert(trackedLinks)
    .values({
      id: randomUUID(),
      linkId,
      emailSendId: null,
      distinctId: link.distinctId,
      source: QR_TRACKED_SOURCE,
      originalUrl: link.originalUrl,
    })
    .onConflictDoNothing({
      target: [trackedLinks.linkId],
      // The arbiter predicate matching the partial unique index
      // `tracked_links_qr_per_link_unique` (… WHERE source = 'qr').
      where: sql`${trackedLinks.source} = ${QR_TRACKED_SOURCE}`,
    })
    .returning({ id: trackedLinks.id });

  if (inserted) return { trackedLinkId: inserted.id, created: true };

  // Lost the race — the concurrent mint's row is the QR row.
  const [winner] = await db
    .select({ id: trackedLinks.id })
    .from(trackedLinks)
    .where(qrRowFilter)
    .limit(1);
  return winner ? { trackedLinkId: winner.id, created: false } : null;
}

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

/**
 * Build the MintedLink for an already-existing LIVE links row (idempotent
 * recovery): resolves its CANONICAL tracked row (the redirect row, never the
 * lazily-minted QR scan row) via the shared canonical-row predicate. Returns
 * null if the link somehow has no tracked row — callers fall back to their
 * conflict path rather than fabricating a dead redirect URL.
 */
async function recoverExistingLink(
  db: Database,
  baseUrl: string,
  row: { id: string; slug: string | null },
): Promise<MintedLink | null> {
  const [tracked] = await db
    .select({ id: sql<string | null>`min(${trackedLinks.id}::text)` })
    .from(trackedLinks)
    .where(and(eq(trackedLinks.linkId, row.id), canonicalTrackedRowFilter()));
  const trackedLinkId = tracked?.id ?? null;
  if (!trackedLinkId) return null;
  return {
    linkId: row.id,
    trackedLinkId,
    url: `${baseUrl}/v1/t/c/${trackedLinkId}`,
    slug: row.slug,
    vanityUrl: row.slug ? vanityUrlFor(baseUrl, row.slug) : null,
    existing: true,
  };
}

export async function mintLink(opts: MintLinkOptions): Promise<MintedLink> {
  assertHttpUrl(opts.url);
  if (opts.slug !== undefined && opts.idempotencyKey !== undefined) {
    throw new Error("mintLink: slug and idempotencyKey are mutually exclusive");
  }
  const type: LinkType = opts.type ?? "public";
  // A public link must NEVER carry a person token — drop any distinctId.
  const distinctId = type === "personal" ? (opts.distinctId ?? null) : null;
  const slug = opts.slug !== undefined ? normalizeSlug(opts.slug) : null;

  const linkId = randomUUID();
  const trackedLinkId = randomUUID();

  // ONE transaction: a half-failed mint would otherwise strand a `links` row
  // that reserves a globally-unique slug with no tracked row — `/l/<slug>`
  // dead (inner join misses) yet the slug 409s every re-mint.
  try {
    await opts.db.transaction(async (tx) => {
      await tx.insert(links).values({
        id: linkId,
        originalUrl: opts.url,
        type,
        slug,
        label: opts.label ?? null,
        description: opts.description ?? null,
        appendRef: opts.appendRef ?? false,
        campaign: opts.campaign ?? null,
        source: opts.source,
        distinctId,
        createdBy: opts.createdBy ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
      });
      await tx.insert(trackedLinks).values({
        id: trackedLinkId,
        linkId,
        emailSendId: null,
        distinctId,
        source: opts.source,
        originalUrl: opts.url,
      });
    });
  } catch (err) {
    // Idempotent recovery. NOTE: these queries run AFTER the aborted
    // transaction, on opts.db directly — the tx object is dead.
    if (slug && isSlugUniqueViolation(err)) {
      // A slug re-mint with the SAME destination + type is the same intent —
      // return the existing LIVE link instead of 409ing a retry.
      const [row] = await opts.db
        .select()
        .from(links)
        .where(and(eq(links.slug, slug), isNull(links.archivedAt)))
        .limit(1);
      if (row && row.originalUrl === opts.url && row.type === type) {
        const recovered = await recoverExistingLink(opts.db, opts.baseUrl, row);
        if (recovered) return recovered;
      }
      // Slug held by an ARCHIVED link (the live lookup misses — archived
      // links keep their slug reserved), a different destination, or a
      // different type → conflict.
      throw new SlugTakenError(slug);
    }
    if (opts.idempotencyKey && isIdempotencyKeyViolation(err)) {
      const [row] = await opts.db
        .select()
        .from(links)
        .where(
          and(
            eq(links.idempotencyKey, opts.idempotencyKey),
            isNull(links.archivedAt),
          ),
        )
        .limit(1);
      if (row && row.originalUrl === opts.url) {
        const recovered = await recoverExistingLink(opts.db, opts.baseUrl, row);
        if (recovered) return recovered;
      }
      if (row) throw new IdempotencyConflictError(opts.idempotencyKey);
      // Defensive: the partial index only covers live rows, so the winning
      // row should always be live — if it vanished, surface the raw error.
      throw err;
    }
    throw err;
  }

  return {
    linkId,
    trackedLinkId,
    url: `${opts.baseUrl}/v1/t/c/${trackedLinkId}`,
    slug,
    vanityUrl: slug ? vanityUrlFor(opts.baseUrl, slug) : null,
    existing: false,
  };
}
