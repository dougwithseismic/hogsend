import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import {
  ALL_IDENTITY_KINDS,
  PublishableAnonymousMergeError,
} from "../../lib/contacts.js";
import { ingestEvent } from "../../lib/ingestion.js";
import { applyListMembership } from "../../lib/preferences.js";
import { errorSchema } from "../../lib/schemas.js";
import { gatePublishableIdentity, listMembershipError } from "../_shared.js";

const eventRequestSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  userId: z.string().min(1).optional(),
  // §4: the caller's analytics anon id (e.g. posthog-js `get_distinct_id()`).
  // 2nd in the resolver's key precedence (`external → email → anonymous →
  // discord`), so when no `external_id` is attached the contact's canonical key
  // BECOMES this value — the browser's own anon events and the server's captures
  // then land on ONE analytics person with zero merge calls. An EXTRA, never a
  // third identity arm: `requireIdentity` still requires email or userId
  // (anon-only public ingest is an abuse vector).
  anonymousId: z.string().min(1).max(200).optional(),
  eventProperties: z.record(z.string(), z.unknown()).optional(),
  contactProperties: z.record(z.string(), z.unknown()).optional(),
  // The event's monetary worth (order total, deal value). First-class — lands
  // on `user_events.value`, the column revenue rollups, conversion definitions,
  // and attribution credits read. Negative = refunds/adjustments.
  value: z.number().finite().optional(),
  // ISO-4217 alpha code for `value` (uppercased at ingest). Ignored without
  // `value`.
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .optional(),
  lists: z.record(z.string(), z.boolean()).optional(),
  // groupType → groupKey association map (e.g. `{ company: "acme.com" }`). The
  // event is recorded against each group (`user_events.groups`), its membership
  // is ensured, and the map is forwarded to analytics as `$groups`. This is
  // ASSOCIATION-ONLY: the ingest path writes NO group properties, so a
  // publishable (pk_) key can reference a group key here but can never write
  // group properties or read groups (those live on the secret-only
  // `/v1/groups` router).
  groups: z.record(z.string().min(1), z.string().min(1)).optional(),
  idempotencyKey: z.string().optional(),
  timestamp: z.string().datetime().optional(),
  // Publishable-key identity assertion (§Phase 1). A pk_ key is anon-only
  // unless it presents a server-minted `userToken` proving the claimed `userId`.
  // Ignored on the secret-key path (which uses `requireIdentity`).
  userToken: z.string().optional(),
});

const eventResponseSchema = z.object({
  stored: z.boolean(),
  exits: z.array(
    z.object({
      journeyId: z.string(),
      stateId: z.string(),
      exited: z.boolean(),
    }),
  ),
  // The contact's canonical key (`external_id ?? anonymous_id ?? id`) — the
  // same key outbound destinations and `hs_t` identity tokens carry, so the
  // caller can `identify()` its analytics session against the contact without
  // any PII round-trip.
  contactKey: z.string(),
  // Present only when the event was durably ingested but the (non-atomic,
  // post-ingest) list-membership write failed. The ingest itself succeeded —
  // surfaced as a warning on a 202, not a 400 that conflates "nothing happened"
  // with "event happened, lists failed" (and would tempt a retry double-ingest).
  listsError: z.string().optional(),
});

const eventRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Events"],
  summary: "Ingest an event",
  description:
    "Stores the event (with eventProperties), merges contactProperties onto the contact, pushes to Hatchet for journey routing, processes exit conditions, and optionally writes list membership. The `Idempotency-Key` header takes precedence over the body field.",
  request: {
    body: {
      content: {
        "application/json": { schema: eventRequestSchema },
      },
    },
  },
  responses: {
    202: {
      content: {
        "application/json": { schema: eventResponseSchema },
      },
      description: "Event accepted and dispatched",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing recipient or unmanageable list membership",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description:
        "Publishable key attempted to act on another identity without a verified userToken",
    },
  },
});

export const eventsRouter = new OpenAPIHono<AppEnv>().openapi(
  eventRoute,
  async (c) => {
    const { db, registry, hatchet, logger, analytics, env } =
      c.get("container");
    const body = c.req.valid("json");

    const guard = gatePublishableIdentity(c, body, env.BETTER_AUTH_SECRET);
    if (guard) return guard;

    // The `Idempotency-Key` header wins over the body field (§2.5).
    const headerKey = c.req.header("idempotency-key");
    const idempotencyKey = headerKey ?? body.idempotencyKey;

    // D1 — a contact is minted by IDENTITY, not by observation. A publishable
    // (pk_) browser write that asserts nothing is pure traffic: it still stores
    // in `user_events`, still routes to journeys, still checks exits (D2), but
    // it no longer mints a `contacts` row for every unidentified visitor.
    //
    // Every conjunct is load-bearing:
    //  - `publishable` — the caller CLASS is the whole guard (D1 is
    //    caller-keyed, not endpoint-keyed). A secret-key server caller asserts
    //    intent and is never refused.
    //  - `!body.userId` — a userId on this path is already token-proven by
    //    `gatePublishableIdentity` above, i.e. a server-authorized identity
    //    assertion. It keeps creating.
    //  - `!body.email` — an asserted email is an identity assertion too. It is
    //    also a D8 PRECONDITION: `resolveContactNoCreate` THROWS unless the
    //    highest-precedence key is `userId`/`anonymousId`, and `email`
    //    outranks `anonymousId` in the resolver. (The gate 403s a publishable
    //    email today, so this conjunct is defense in depth against a future
    //    email arm silently becoming a 500.)
    //  - `body.value === undefined` — D9's escape hatch. `conversions`,
    //    `funnel_progress` and `deals` all hold `.notNull()` FKs to
    //    `contacts.id` and `packages/db` is out of boundary, so a refused
    //    ingest can perform no conversion, funnel or attribution work at all. A
    //    money-bearing browser event is therefore treated as an identity
    //    assertion so e-commerce revenue conversions and attribution credits
    //    keep firing.
    //  - `body.groups === undefined` — D10, the same hatch for the same reason.
    //    `group_memberships.contact_id` is a fourth `.notNull()` FK to
    //    `contacts.id`, so a refused ingest writes NEITHER the `groups` row
    //    (minted by `associateGroups` → `resolveGroupId`) NOR the membership.
    //    But browser group ASSOCIATION is a documented first-class capability —
    //    root `CLAUDE.md`: "Publishable/browser keys may ONLY associate —
    //    attach a `groups` map to an event via `hogsend.group()` → /v1/events"
    //    — and `@hogsend/js` attaches the map to every capture regardless of
    //    identification, so a pre-login `hogsend.group()` sends exactly this
    //    shape. A visitor calling `hogsend.group()` is asserting an association
    //    INTENT, which is more than pure observation, so it keeps creating.
    //    Association-only still: the property writes a group row can receive
    //    remain secret-key-only, unchanged by this hatch.
    //  - `body.anonymousId` — the other half of D8: refusal is legal only where
    //    the key is STABLE. With no key at all the resolve throws either way
    //    (today: "requires at least one of…"), so restricting the guard to the
    //    shape that has a real refusal key changes no outcome and keeps the
    //    thrown message pointing at the actual defect.
    //
    // NOT collapsed into the policy's `allowMerge` clamp even though the
    // conditions overlap here: that leg guards MERGE/poison, this one guards
    // CREATION.
    const observationOnly =
      c.get("publishable") === true &&
      !body.userId &&
      !body.email &&
      body.value === undefined &&
      body.groups === undefined &&
      !!body.anonymousId;

    let result: Awaited<ReturnType<typeof ingestEvent>>;
    try {
      result = await ingestEvent({
        db,
        registry,
        hatchet,
        logger,
        // §5.3: thread the active analytics provider so a collide-MERGE /
        // key-flip fires the provider-neutral `mergeIdentities` stitch.
        analytics,
        // PRD 06 T3 (L5 rows 1-3): trust is DECLARED by this caller, not
        // re-inferred inside the resolver.
        //  - `create` — the D1 creation guard (see `observationOnly` above): a
        //    token-less pk_ observation refuses to mint; everything else keeps
        //    creating. Deliberately a SEPARATE leg from `allowMerge`:
        //    merge-clamping and creation-refusal are different questions that
        //    only happen to agree on part of this route's input.
        //  - `allowMerge` — §Phase 1 GAP-1: a publishable (pk_) browser write
        //    is anon-clamped — its browser-readable `anonymousId` may NOT
        //    attach to / merge / poison an already-identified victim contact.
        //    Declared "anonymous-only" even for a token-proven `userId` (row
        //    2): the clamp is inert there because the DERIVATION sees a
        //    non-anon key — hard-coding the conclusion ("any") would silently
        //    break on the next key-precedence change. Secret-key ingest is
        //    never clamped.
        //  - `trustedKinds` — the evidence `gatePublishableIdentity` already
        //    computed: a publishable `userId` reaching this call IS
        //    token-proven (the gate 403'd every other identity-claiming shape,
        //    incl. any pk_ email), so a pk_ caller may assert `anonymous`
        //    (+`external` with that proof); a secret caller all four. Declared
        //    now, enforced by T5.
        policy:
          c.get("publishable") === true
            ? {
                create: observationOnly ? "refuse-on-miss" : "on-miss",
                allowMerge: "anonymous-only",
                trustedKinds: body.userId
                  ? ["anonymous", "external"]
                  : ["anonymous"],
              }
            : {
                create: "on-miss",
                allowMerge: "any",
                trustedKinds: ALL_IDENTITY_KINDS,
              },
        event: {
          event: body.name,
          userId: body.userId,
          userEmail: body.email,
          // §4: 2nd-precedence resolver key — lets the contact's canonical key
          // equal the browser anon id (zero-merge stitch).
          anonymousId: body.anonymousId,
          eventProperties: body.eventProperties ?? {},
          contactProperties: body.contactProperties,
          value: body.value,
          currency: body.currency,
          // groupType→groupKey association (association-only; no property write).
          // Forwarded as `$groups` on the mirrored analytics capture.
          groups: body.groups,
          idempotencyKey,
          // §2.5: caller-supplied event time (backfill/replay). The validated
          // ISO string is coerced to a Date inside ingestEvent.
          occurredAt: body.timestamp,
          // Provenance derived from the authenticated key CLASS, never the
          // request body (so it can't be spoofed): a publishable (pk_) key is
          // always an in-app surface interaction from @hogsend/js; a secret key
          // is the server-side data plane. "inapp" still fans out to PostHog
          // (the loop-guard only special-cases "posthog").
          source: c.get("publishable") === true ? "inapp" : "api",
        },
      });
    } catch (err) {
      // A publishable anon write that resolved to an identified victim contact
      // (or would drive a merge) is rejected at the resolver — surface as 403.
      if (err instanceof PublishableAnonymousMergeError) {
        return c.json({ error: err.message }, 403);
      }
      throw err;
    }

    // Lists applied AFTER ingest so the contact exists (§2.5 lists ordering).
    // `applyListMembership` writes `email_preferences` independently of the
    // contacts row, so it doesn't race the resolve. Requires a resolvable email.
    //
    // The ingest above is already durable (event stored, journeys dispatched,
    // exits processed). A list-write failure here must NOT be reported as a 400
    // — that would (a) hide a successful ingest behind a "nothing happened"
    // status and (b) tempt a client to retry, re-ingesting the event. Surface it
    // as a `listsError` warning on the 202 instead.
    let listsError: string | undefined;
    // §Phase 1 GAP-2 (defense in depth): a publishable caller reaching here has
    // no token-less email/userId (the gate 403'd it) — but assert it explicitly
    // so a future change that lets `anonymousId` carry a list write can't
    // silently write `email_preferences` for a victim. `applyListMembership`
    // needs a resolvable email anyway; a publishable list write is a no-op.
    const publishableListWrite =
      c.get("publishable") === true && (body.email || body.userId);
    if (
      !publishableListWrite &&
      body.lists &&
      Object.keys(body.lists).length > 0
    ) {
      try {
        await applyListMembership({
          db,
          userId: body.userId,
          email: body.email,
          lists: body.lists,
        });
      } catch (err) {
        listsError = listMembershipError(err);
      }
    }

    return c.json({ ...result, ...(listsError ? { listsError } : {}) }, 202);
  },
);
