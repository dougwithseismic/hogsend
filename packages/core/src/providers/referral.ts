import { normalizeWhere } from "../conditions/index.js";
import { type DurationObject, days, durationToMs } from "../duration.js";
import type { PropertyCondition } from "../types/conditions.js";
import type { JourneyWhere } from "../types/journey.js";

/**
 * `defineReferral` (PRD 05) - the referral KIND, in the house pattern of
 * `defineJourney` / `defineConversion` / `defineAccountLink`. A definition says
 * WHERE a referral link points, WHAT counts as a qualified referee, and HOW
 * LONG a cold touch stays bindable. It says nothing about attribution model,
 * tree depth or level weights: those are REPORT-TIME parameters, so a change of
 * mind costs nothing and backfills nothing.
 *
 * Types and pure functions only - no DB, no engine import - so `@hogsend/core`
 * alone is enough to author one.
 */

// ---------------------------------------------------------------------------
// Hooks - the IN-PROCESS veto plane
// ---------------------------------------------------------------------------

/**
 * What `beforeTouch` sees: the edge ABOUT to be written, before any row exists.
 *
 * `refereeKey` is the canonical key of whoever clicked, which on a cold touch
 * is an ANONYMOUS id. `refereeContactId` is set only when the toucher was
 * already identified, so a hook that wants to refuse anonymous touches refuses
 * on `refereeContactId === null`.
 */
export interface BeforeTouchContext {
  referralId: string;
  referrerContactId: string;
  refereeKey: string;
  refereeContactId: string | null;
  source: string;
  linkId: string | null;
  clickId: string | null;
  properties: Record<string, unknown>;
}

/** What `beforeBind` sees: an existing touch about to gain its second end. */
export interface BeforeBindContext {
  referralId: string;
  touchId: string;
  referrerContactId: string;
  refereeKey: string;
  /** The contact the referee resolved to at identify time. Never null here. */
  refereeContactId: string;
  touchedAt: Date;
  properties: Record<string, unknown>;
}

/** What `beforeQualify` sees: a BOUND touch about to be marked qualified. */
export interface BeforeQualifyContext {
  referralId: string;
  touchId: string;
  referrerContactId: string;
  refereeContactId: string;
  /** The event that triggered the qualify evaluation. */
  event: string;
  eventProperties: Record<string, unknown>;
  conversionId: string | null;
  properties: Record<string, unknown>;
}

/**
 * A hook verdict. Deliberately EXPLICIT in both directions (`{ ok: true }` /
 * `{ ok: false, reason }`) rather than the `void`-means-allow shape
 * `beforeLink` uses: a referral veto is recorded on the row as
 * `rejected_reason`, so the reason string is not optional decoration - it is
 * the only thing that later explains why an edge was thrown away.
 */
export type ReferralVerdict = { ok: true } | { ok: false; reason: string };

/**
 * The three referral vetoes. Each runs BEFORE its write and may be async.
 * They are NOT a delivery mechanism: the FACTS ride the bus as `referral.*`
 * events, and the "after" of every stage is a journey on the matching event.
 */
export interface ReferralHooks {
  beforeTouch?(
    ctx: BeforeTouchContext,
  ): ReferralVerdict | Promise<ReferralVerdict>;
  beforeBind?(
    ctx: BeforeBindContext,
  ): ReferralVerdict | Promise<ReferralVerdict>;
  beforeQualify?(
    ctx: BeforeQualifyContext,
  ): ReferralVerdict | Promise<ReferralVerdict>;
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

/** What `defineReferral` ACCEPTS. */
export interface ReferralMeta extends ReferralHooks {
  /**
   * Stable id, recorded on every touch. Optional: a product with one referral
   * program should not have to name it.
   */
  id?: string;
  name?: string;
  description?: string;
  /** The `shared` link every referrer's mint produces. */
  link: {
    /**
     * Where the referee lands. A function receives the referrer's contact so a
     * program can route by plan, locale or cohort.
     */
    destination: string | ((referrer: ReferralLinkSubject) => string);
    /**
     * Derive the vanity slug from the referrer (a typed code IS a slug).
     * Default: a short random slug. Return null/undefined to skip the vanity
     * path for that referrer.
     */
    slugFrom?: (referrer: ReferralLinkSubject) => string | null | undefined;
    /** Forwarded to `mintLink` as the campaign grouping. */
    campaign?: string;
  };
  /**
   * What promotes a BOUND referee to qualified. Without it, bind IS qualify -
   * the referral is earned the moment the referee is a known person.
   */
  qualify?: {
    event: string;
    /**
     * Property conditions on that event - array or the same builder journeys
     * use, so "first paid invoice over 10" is expressible without a custom
     * veto: `(b) => b.prop("value").gte(10)`.
     */
    where?: JourneyWhere;
  };
  /**
   * How long a touch stays bindable. A touch older than this at identify time
   * is rejected with `window`. Default 30 days: Rewardful and Cello default to
   * 60, but product referrals convert faster and a long window mostly credits
   * coincidences.
   */
  bindWindow?: DurationObject;
}

/** The subset of a contact a link callback may read. */
export interface ReferralLinkSubject {
  contactId: string;
  /** The canonical contact key (`external_id ?? anonymous_id ?? id`). */
  userId: string | null;
  email: string | null;
  properties: Record<string, unknown>;
}

/** The validated, normalized definition the engine registers. */
export interface DefinedReferral {
  meta: ReferralMeta;
  /** `meta.id ?? "default"` - resolved once, so nothing downstream re-defaults. */
  id: string;
  /** `qualify.where`, normalized to conditions at DEFINITION time. */
  qualifyWhere: PropertyCondition[] | undefined;
  /** `meta.bindWindow ?? days(30)`, resolved once. */
  bindWindow: DurationObject;
}

/**
 * A referral id is a DB discriminator and (later) a query parameter, so it
 * takes the same charset as a `ctx.variant` key: letter/digit first, then
 * letters, digits, `_`, `.` and `-`, max 64.
 */
export const REFERRAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** The default referral id. A single-program product never names its program. */
export const DEFAULT_REFERRAL_ID = "default";

/**
 * Identity/validating factory. Resolves `id`, `bindWindow` and the builder-form
 * `qualify.where` ONCE at definition time (mirrors `defineConversion`), and
 * throws on the misconfigurations that would otherwise fail silently at 3am.
 */
export function defineReferral(meta: ReferralMeta): DefinedReferral {
  const id = meta.id ?? DEFAULT_REFERRAL_ID;

  if (!REFERRAL_ID_RE.test(id)) {
    throw new Error(
      `referral id "${id}" is invalid - it must match ` +
        `${REFERRAL_ID_RE.source} (letter/digit first, max 64 chars), because ` +
        "the id is a DB discriminator and a report query parameter",
    );
  }

  const { destination } = meta.link;
  if (typeof destination === "string") {
    // A relative or non-http destination is a link that 302s nowhere useful,
    // and the failure only shows up on a referee's first click.
    let parsed: URL;
    try {
      parsed = new URL(destination);
    } catch {
      throw new Error(
        `referral "${id}" has an invalid link.destination: ${destination}`,
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `referral "${id}" link.destination must be http(s), got ` +
          `"${parsed.protocol}"`,
      );
    }
  } else if (typeof destination !== "function") {
    throw new Error(
      `referral "${id}" link.destination must be a URL string or a function`,
    );
  }

  if (meta.qualify !== undefined && !meta.qualify.event) {
    throw new Error(
      `referral "${id}" declares qualify without an event - a qualify step ` +
        "with no trigger can never fire, which silently strands every bound " +
        "referee short of qualified",
    );
  }

  const bindWindow = meta.bindWindow ?? days(30);
  if (!(durationToMs(bindWindow) > 0)) {
    // A zero/negative window rejects EVERY touch as out-of-window the instant
    // it binds, so the program looks wired and produces nothing.
    throw new Error(
      `referral "${id}" declares a non-positive bindWindow - it is the MAXIMUM ` +
        "AGE a touch may have when the referee identifies. Use e.g. days(30)",
    );
  }

  return {
    meta,
    id,
    qualifyWhere: normalizeWhere(meta.qualify?.where),
    bindWindow,
  };
}
