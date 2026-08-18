import {
  DEFAULT_REFERRAL_ID,
  type DefinedReferral,
  type ReferralLinkSubject,
} from "@hogsend/core";
import { contacts, type Database } from "@hogsend/db";
import { eq } from "drizzle-orm";
import { mintLink, SlugTakenError } from "./links.js";
import { createLogger } from "./logger.js";
import type { ReferralRegistry } from "./referral-registry.js";
import { getReferralRuntime } from "./referral-runtime.js";

/**
 * `getReferralLink` (PRD 05 §7.2): the referrer's share link, journey-safe and
 * idempotent. THE ONE mint path for a `shared` link, so `links.referral_id`,
 * `owner_contact_id` and `append_ref` can never be set inconsistently.
 *
 * Journey-safe means two things. It issues NO durable Hatchet call, so it is
 * invisible to the replay journal and needs no `ctx.once` wrap. And it is
 * IDEMPOTENT at the database: a replay re-minting the same referrer's link
 * recovers the existing row rather than minting a second one, either by the
 * vanity slug or by the deterministic idempotency key below.
 */

/** The subset of the container this needs, structurally - avoids a cycle. */
export interface ReferralLinkContainer {
  db: Database;
  env: { API_PUBLIC_URL: string };
  referrals: ReferralRegistry;
}

export interface GetReferralLinkOptions {
  /** The `defineReferral` id, or the definition itself. Default `"default"`. */
  referral?: string | DefinedReferral;
  /** The REFERRER - the contact who earns the credit for this link. */
  contactId: string;
  /**
   * The request container, when the caller has one. Omitted inside a journey /
   * durable task, where the process runtime installed by `createHogsendClient`
   * is read instead.
   */
  container?: ReferralLinkContainer;
}

export interface ReferralLink {
  /**
   * The share URL. The VANITY url (`/l/<slug>`) when the referral derives a
   * slug, else the UUID redirect - so a program with `slugFrom` hands out the
   * typeable code and one without hands out the durable one.
   */
  url: string;
  /** The normalized vanity slug, or null when the program derives none. */
  slug: string | null;
  /** The durable `links.id`. */
  linkId: string;
  /** The `tracked_links.id` - the `:id` in `/v1/t/c/:id`. */
  trackedLinkId: string;
  /** The referral this link belongs to. */
  referralId: string;
  /** True when the mint RECOVERED an existing link rather than inserting one. */
  existing: boolean;
}

const fallbackLogger = createLogger(process.env.LOG_LEVEL);

/** Warn ONCE per (referral, slug) that a slug collided and we fell back. */
const warnedSlugFallbacks = new Set<string>();

/**
 * Resolve (or mint) the `shared` link that credits `contactId` under
 * `referral`. Safe to call on every journey run: the second call returns the
 * first call's link.
 */
export async function getReferralLink(
  opts: GetReferralLinkOptions,
): Promise<ReferralLink> {
  const runtime = opts.container
    ? {
        db: opts.container.db,
        baseUrl: opts.container.env.API_PUBLIC_URL,
        referrals: opts.container.referrals,
      }
    : getReferralRuntime();
  if (!runtime) {
    throw new Error(
      "getReferralLink: no referrals are configured. Pass them to " +
        "createHogsendClient({ referrals: [myReferral] }) in BOTH index.ts " +
        "and worker.ts",
    );
  }

  const referral =
    typeof opts.referral === "object" && opts.referral !== null
      ? opts.referral
      : runtime.referrals.get(opts.referral ?? DEFAULT_REFERRAL_ID);
  const requestedId =
    typeof opts.referral === "string" ? opts.referral : opts.referral?.id;
  if (!referral) {
    throw new Error(
      `getReferralLink: no referral "${requestedId ?? DEFAULT_REFERRAL_ID}" ` +
        `is registered (registered: ${
          runtime.referrals.ids().join(", ") || "none"
        }). Pass it to createHogsendClient({ referrals: [...] })`,
    );
  }

  const subject = await loadSubject(runtime.db, opts.contactId);
  const { destination, slugFrom, campaign } = referral.meta.link;
  const url =
    typeof destination === "function" ? destination(subject) : destination;
  const slug = slugFrom?.(subject) ?? null;

  const base = {
    db: runtime.db,
    baseUrl: runtime.baseUrl,
    url,
    source: "referral",
    type: "shared" as const,
    ownerContactId: opts.contactId,
    referralId: referral.id,
    // Arrival attribution is what makes a COLD referral touch possible at all:
    // the click carries no clicker key (a shared link stitches nobody), so the
    // referee's anonymous id only appears when the landing page reports the
    // appended `hs_ref` back to POST /v1/t/arrive.
    appendRef: true,
    ...(campaign ? { campaign } : {}),
  };
  // `mintLink` rejects slug + idempotencyKey together (a slug IS an
  // idempotency key), so the two idempotency strategies are exclusive by
  // construction: WITH a slug, re-mint recovery is slug + same-url + same-type
  // + same-owner; WITHOUT one, the deterministic key below.
  const idempotencyKey = `referral:${referral.id}:${opts.contactId}`;

  if (slug) {
    try {
      const minted = await mintLink({ ...base, slug });
      return toResult(minted, referral.id);
    } catch (err) {
      if (!(err instanceof SlugTakenError)) throw err;
      // Someone else holds the slug (two referrers whose `slugFrom` collide,
      // or an archived link still reserving it). A referrer with no link at
      // all is the worse failure, so fall back to the slugless idempotent
      // mint - they get a working share URL, just not the pretty one.
      const warnKey = `${referral.id}:${slug}`;
      if (!warnedSlugFallbacks.has(warnKey)) {
        warnedSlugFallbacks.add(warnKey);
        fallbackLogger.warn(
          "referral slug is already taken - minting a slugless link instead",
          { referralId: referral.id, slug, contactId: opts.contactId },
        );
      }
    }
  }

  const minted = await mintLink({ ...base, idempotencyKey });
  return toResult(minted, referral.id);
}

function toResult(
  minted: Awaited<ReturnType<typeof mintLink>>,
  referralId: string,
): ReferralLink {
  return {
    url: minted.vanityUrl ?? minted.url,
    slug: minted.slug,
    linkId: minted.linkId,
    trackedLinkId: minted.trackedLinkId,
    referralId,
    existing: minted.existing,
  };
}

/** The referrer as `link.destination` / `link.slugFrom` see them. */
async function loadSubject(
  db: Database,
  contactId: string,
): Promise<ReferralLinkSubject> {
  const [row] = await db
    .select({
      id: contacts.id,
      externalId: contacts.externalId,
      anonymousId: contacts.anonymousId,
      email: contacts.email,
      properties: contacts.properties,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  if (!row) {
    // A link owned by a contact that does not exist would fail the FK anyway;
    // failing here names the actual problem.
    throw new Error(`getReferralLink: no contact ${contactId}`);
  }
  return {
    contactId: row.id,
    userId: row.externalId ?? row.anonymousId ?? row.id,
    email: row.email,
    properties: (row.properties ?? {}) as Record<string, unknown>,
  };
}
