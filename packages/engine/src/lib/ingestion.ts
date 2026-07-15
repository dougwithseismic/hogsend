import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type {
  AnalyticsEventMirrorConfig,
  AnalyticsProvider,
  GroupsAssociation,
  PropertyCondition,
} from "@hogsend/core";
import { evaluatePropertyConditions } from "@hogsend/core";
import type { JourneyRegistry } from "@hogsend/core/registry";
import type { JourneyMeta } from "@hogsend/core/types";
import {
  type Database,
  journeyBlueprints,
  journeyStates,
  userEvents,
} from "@hogsend/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { checkBucketMembership } from "../buckets/check-membership.js";
import { BLUEPRINT_RUN_EVENT } from "../journeys/constants.js";
import { logTransition } from "../journeys/journey-log.js";
import {
  logResidualTwins,
  mergeAnalyticsIdentities,
} from "./analytics-identity.js";
import {
  getAnalytics,
  getAnalyticsEventMirror,
} from "./analytics-singleton.js";
import { recordAttributionCredits } from "./attribution.js";
import {
  ContactProvenanceLostError,
  resolveOrCreateContact,
} from "./contacts.js";
import {
  conversionEventId,
  enqueueConversionDispatches,
} from "./conversion-dispatch.js";
import {
  evaluateConversionsAtIngest,
  getConversionRegistry,
} from "./conversions.js";
import { getCrmSyncConfig } from "./crm-registry-singleton.js";
import { recordFunnelProgressAtIngest } from "./funnel-progress.js";
import { applyFunnelTransitionsAtIngest } from "./funnel-transitions.js";
import { associateGroups } from "./groups.js";
import type { Logger } from "./logger.js";

export interface IngestEvent {
  event: string;
  /** D1: optional — email-only / anonymous events resolve a key downstream. */
  userId?: string;
  userEmail?: string;
  /** D1: future anonymous→identified path. Threaded into the resolver. */
  anonymousId?: string;
  /**
   * ENGINE-INTERNAL provenance — the subject contact's unforgeable row id
   * (`contacts.id`). Set ONLY by engine-internal re-emit sites that already
   * resolved the subject (this fn's own downstream re-ingests, the feed
   * mark/clear re-ingests). Pins the resolver to that exact row so a contact's
   * own canonical key round-tripping as `userId` folds back in instead of minting
   * a phantom `external_id` twin. NEVER set from a request body (the public route
   * schemas omit it); the public/publishable boundary cannot forge it.
   */
  contactId?: string;
  /**
   * Discord user id (snowflake). Resolves a `discord`-keyed contact (a later
   * per-member link merges it into the email contact).
   */
  discordId?: string;
  /** D2: → `user_events` + Hatchet `trigger.where`/`exitOn` ONLY. */
  eventProperties: Record<string, unknown>;
  /** D2: → `contacts.properties` merge ONLY. */
  contactProperties?: Record<string, unknown>;
  /**
   * The groupType→groupKey association map for this event — persisted on
   * `user_events.groups`, drives group membership (each group row is ensured +
   * a `group_memberships` row upserted for the resolved contact), and forwards
   * to analytics as `$groups` alongside the mirrored capture. Optional (null on
   * `user_events` when unset).
   */
  groups?: GroupsAssociation;
  /**
   * The event's own monetary worth (deal value, order total). Stored on the
   * first-class `user_events.value` column — the revenue spine every rollup,
   * conversion definition, and attribution credit reads from. Non-finite
   * numbers are dropped (with a warn) rather than failing the ingest.
   */
  value?: number;
  /** ISO-4217 alpha code for `value`; uppercased here. Defaults to null. */
  currency?: string;
  idempotencyKey?: string;
  /**
   * Caller-supplied event time (§2.5 `timestamp`). When set, `user_events`
   * `occurred_at` is stamped from it (backfill/replay) instead of defaulting to
   * the ingest instant. Accepts a `Date` or an ISO-8601 string.
   */
  occurredAt?: Date | string;
  /**
   * Where the event entered the pipeline — a webhook source id ("posthog",
   * "stripe", …), "api" (public data plane), "studio" (Debug panel), a connector
   * id, "journey" (cross-journey trigger), etc. Stored on `user_events.source`
   * so the Events feed can show + filter by origin. Optional (null when unset).
   */
  source?: string;
}

export interface ExitResult {
  journeyId: string;
  stateId: string;
  exited: boolean;
}

export interface IngestResult {
  stored: boolean;
  exits: ExitResult[];
  /**
   * The contact's canonical text key after this ingest's identity resolve
   * (`external_id ?? anonymous_id ?? id`). This is the same key outbound
   * destinations emit as `userId` and `hs_t` identity tokens carry — callers
   * (e.g. a site's subscribe endpoint) can hand it to their analytics
   * `identify()` so the session joins the person the contact's email events
   * land on, without any PII leaving Hogsend.
   */
  contactKey: string;
}

/**
 * Ingest a connector transform RESULT — a single {@link IngestEvent}, an ARRAY
 * of events (a dual-side fan-out, e.g. a Discord reaction yields a reactor-keyed
 * `reaction_added` AND an author-keyed `reaction_received`), or null. Each
 * element ingests INDEPENDENTLY with per-element error isolation, so one bad
 * element never aborts its siblings, plus a defensive zero-key skip mirroring
 * `pushLinkClickEvent` (`resolveOrCreateContact` throws on a zero-key event).
 * `source` stamps every element's `user_events.source`.
 */
export async function ingestTransformResult(opts: {
  result: IngestEvent | IngestEvent[] | null;
  db: Database;
  registry: JourneyRegistry;
  hatchet: HatchetClient;
  logger: Logger;
  source: string;
  analytics?: AnalyticsProvider;
}): Promise<{ ingested: number; exits: number }> {
  const { result, db, registry, hatchet, logger, source, analytics } = opts;
  if (!result) return { ingested: 0, exits: 0 };
  const events = Array.isArray(result) ? result : [result];
  let ingested = 0;
  let exits = 0;
  for (const event of events) {
    if (
      !event.userId &&
      !event.userEmail &&
      !event.anonymousId &&
      !event.discordId
    ) {
      logger.warn("ingestTransformResult: skipping zero-key event", {
        event: event.event,
        source,
      });
      continue;
    }
    try {
      const r = await ingestEvent({
        db,
        registry,
        hatchet,
        logger,
        event: { ...event, source },
        analytics,
      });
      ingested++;
      exits += r.exits.length;
    } catch (err) {
      logger.warn("ingestTransformResult: element ingest failed", {
        event: event.event,
        source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { ingested, exits };
}

/**
 * Event-name filter for the {@link AnalyticsEventMirrorConfig}: an `allow` list
 * (when set) gates to those names, then `deny` removes any. The `source` filter
 * (never mirror `"posthog"`-origin events) is enforced at the call site.
 */
function shouldMirrorEvent(
  eventName: string,
  cfg: AnalyticsEventMirrorConfig,
): boolean {
  if (cfg.allow && !cfg.allow.includes(eventName)) return false;
  if (cfg.deny?.includes(eventName)) return false;
  return true;
}

/**
 * Blueprint dispatch (spec §5) — the DB-lookup counterpart of the static
 * `onEvents` registration code journeys get at boot. Code journeys can't gain
 * a trigger without a worker redeploy; a blueprint row created at 3pm must
 * fire at 3:01. So on every ingested event this queries the enabled
 * `journey_blueprints` whose `triggerEvent` matches (served by the
 * `(trigger_event, status)` index), applies `triggerWhere` with the SAME
 * `evaluatePropertyConditions` the interpreter's enrollment guard re-checks
 * with (dispatch and guard must agree, and both see the serializable-scalar
 * payload), and pushes one `blueprint:run` per match to the single
 * statically-registered `journey-blueprint-interpreter` task.
 *
 * Returns the number of dispatched enrollment attempts.
 */
export async function checkBlueprintTriggers(opts: {
  db: Database;
  hatchet: HatchetClient;
  logger: Logger;
  event: {
    name: string;
    userId: string;
    userEmail: string;
    /** The serializable-scalar subset that will reach the interpreter. */
    properties: Record<string, string | number | boolean | null>;
  };
}): Promise<number> {
  const { db, hatchet, logger, event } = opts;

  const candidates = await db
    .select({
      id: journeyBlueprints.id,
      version: journeyBlueprints.version,
      triggerWhere: journeyBlueprints.triggerWhere,
    })
    .from(journeyBlueprints)
    .where(
      and(
        eq(journeyBlueprints.triggerEvent, event.name),
        eq(journeyBlueprints.status, "enabled"),
      ),
    );

  let dispatched = 0;
  for (const bp of candidates) {
    const where = (bp.triggerWhere ?? []) as unknown as PropertyCondition[];
    if (
      where.length > 0 &&
      !evaluatePropertyConditions({
        conditions: where,
        properties: event.properties,
      })
    ) {
      continue;
    }
    await hatchet.events.push(BLUEPRINT_RUN_EVENT, {
      blueprintId: bp.id,
      blueprintVersion: bp.version,
      userId: event.userId,
      userEmail: event.userEmail,
      triggerProperties: event.properties,
    });
    dispatched += 1;
  }

  if (dispatched > 0) {
    logger.info("Blueprint runs dispatched", {
      event: event.name,
      userId: event.userId,
      dispatched,
    });
  }
  return dispatched;
}

export async function ingestEvent(opts: {
  db: Database;
  registry: JourneyRegistry;
  hatchet: HatchetClient;
  logger: Logger;
  event: IngestEvent;
  /**
   * The active analytics provider (`c.get("container").analytics`). When the
   * identity resolve folds two keys into one (collide-MERGE or canonical-key
   * flip), the engine fires the provider-neutral `mergeIdentities` primitive so
   * the analytics person store stitches the same way the contact store did
   * (§5.3). Optional: absent ⇒ DB-only resolve (no stitch), exactly as before; a
   * provider without `identityMerge` no-ops cleanly.
   */
  analytics?: AnalyticsProvider;
  /**
   * Operator policy for mirroring THIS event into `analytics` via `capture()`.
   * Test/advanced override: real call sites omit it and the resolved config is
   * read from the analytics singleton (installed by `createHogsendClient`), so
   * the mirror fires on every ingest path without threading. Absent on both ⇒
   * no mirror.
   */
  eventMirror?: AnalyticsEventMirrorConfig;
  /**
   * PUBLISHABLE (browser, pk_) safety clamp (§Phase 1 GAP-1). Threaded into the
   * identity resolve so an anon-only browser write cannot attach to / merge /
   * poison an already-identified victim contact via the browser-readable
   * `anonymousId`. Only the public-data-plane event route sets this; every
   * server-side ingest path (webhooks, connectors, journeys) leaves it false, so
   * their behavior is unchanged.
   */
  restrictToAnonymous?: boolean;
}): Promise<IngestResult> {
  const { db, registry, hatchet, logger, event, analytics, eventMirror } = opts;

  // (1) Resolve identity FIRST (awaited — no longer fire-and-forget). The
  // contact-referencing tables join on a NOT NULL text key, so an email-only /
  // anonymous event (D1 optional userId) needs a canonical key resolved before
  // any insert (risk 2). The resolver applies ONLY contactProperties to
  // `contacts.properties` (D2 split) and returns BOTH the canonical contact id
  // AND its resolved string key (external_id ?? anonymous_id ?? contact.id —
  // risk 1/6), so no second read-back of the contact row is needed.
  let resolved: Awaited<ReturnType<typeof resolveOrCreateContact>>;
  try {
    resolved = await resolveOrCreateContact({
      db,
      userId: event.userId,
      email: event.userEmail || undefined,
      anonymousId: event.anonymousId,
      discordId: event.discordId,
      // ENGINE-INTERNAL provenance pin (never from a request body — public route
      // schemas omit it). Pins to the subject's own row so an internal re-emit
      // whose userId is the contact's canonical key folds in, not a phantom twin.
      contactId: event.contactId,
      contactProperties: event.contactProperties,
      restrictToAnonymous: opts.restrictToAnonymous,
      // First-touch contact provenance from the event's pipeline origin — a
      // Contact Source ("clay"/"attio") or "api"/"posthog"/…; only stamped when
      // the contact is created (or first fill-in-linked) with no prior source.
      source: event.source,
    });
  } catch (err) {
    // Provenance pin pointed at a hard-deleted/unfollowable subject: drop the
    // internal re-emit (do NOT value-fall-back — that could mint the very twin
    // the pin prevents). Reachable only for a hard-deleted subject.
    if (err instanceof ContactProvenanceLostError) {
      logger.warn("identity.provenance.lost — dropping internal re-emit", {
        event: event.event,
        contactId: err.contactId,
        source: event.source ?? null,
      });
      return {
        stored: false,
        exits: [],
        contactKey: event.userId ?? event.anonymousId ?? err.contactId,
      };
    }
    throw err;
  }
  const {
    id: contactId,
    resolvedKey,
    mergedKeys,
    mergedIdentifiedKeys,
    merged,
  } = resolved;

  // Caller-supplied event time (backfill/replay). Coerced to a Date; undefined
  // falls back to the `occurred_at` DB default (ingest instant).
  const occurredAt = event.occurredAt ? new Date(event.occurredAt) : undefined;

  // Money normalization — permissive at the spine (webhook sources feed this
  // path with arbitrary payloads): a non-finite value or malformed currency is
  // dropped with a warn, never a failed ingest. Currency without value is
  // meaningless and dropped; value without currency stores with null currency
  // (single-currency deploys omit it everywhere).
  let value: number | null = null;
  let currency: string | null = null;
  if (event.value !== undefined) {
    if (typeof event.value === "number" && Number.isFinite(event.value)) {
      value = event.value;
      if (event.currency !== undefined) {
        const code = event.currency.trim().toUpperCase();
        if (/^[A-Z]{3}$/.test(code)) {
          currency = code;
        } else {
          logger.warn("ingestEvent: dropping malformed currency", {
            event: event.event,
            currency: event.currency,
          });
        }
      }
    } else {
      logger.warn("ingestEvent: dropping non-finite value", {
        event: event.event,
      });
    }
  }

  // (2) Idempotency dedup + `user_events` insert keyed on the resolved key, with
  // ONLY eventProperties in the properties bag (D2). `ctx.trigger` now supplies a
  // deterministic key (`journeyTrigger:<runAnchor>:<site>:<event>`), so a journey
  // replay re-pushing the same trigger hits the onConflictDoNothing early-return
  // below — the push, checkExits, contact upsert, and alias never re-fire.
  let idempotentInsertId: string | undefined;
  let insertedRow: { id: string; occurredAt: Date } | undefined;
  if (event.idempotencyKey) {
    const result = await db
      .insert(userEvents)
      .values({
        userId: resolvedKey,
        event: event.event,
        properties: event.eventProperties,
        groups: event.groups ?? null,
        value,
        currency,
        source: event.source ?? null,
        idempotencyKey: event.idempotencyKey,
        ...(occurredAt ? { occurredAt } : {}),
      })
      .onConflictDoNothing({
        target: userEvents.idempotencyKey,
      })
      .returning({ id: userEvents.id, occurredAt: userEvents.occurredAt });

    if (result.length === 0) {
      return { stored: false, exits: [], contactKey: resolvedKey };
    }
    idempotentInsertId = result[0]?.id;
    insertedRow = result[0];
  } else {
    const result = await db
      .insert(userEvents)
      .values({
        userId: resolvedKey,
        event: event.event,
        properties: event.eventProperties,
        groups: event.groups ?? null,
        value,
        currency,
        source: event.source ?? null,
        ...(occurredAt ? { occurredAt } : {}),
      })
      .returning({ id: userEvents.id, occurredAt: userEvents.occurredAt });
    insertedRow = result[0];
  }

  // (2b) §5.3 — fire the provider-neutral identity merge at the two resolver
  // outcomes where two keys fold into one (collide-MERGE or canonical-key flip).
  // Placed INSIDE the idempotency-guarded block (after a FRESH insert; the
  // duplicate path returned early above) so a Hatchet/client retry with the same
  // idempotencyKey does NOT re-fire `alias` — honoring the "only at the moment
  // two keys first become one" contract (PostHog `alias` is harmless on replay
  // but firing per-retry adds queue noise). MF-2: `mergedKeys` already excludes
  // identified `external_id`s (the resolver split them out); fire only the safe
  // anon/uuid keys, and surface the excluded identified twins for observability.
  if (mergedKeys?.length || mergedIdentifiedKeys?.length) {
    if (mergedKeys?.length) {
      mergeAnalyticsIdentities({
        analytics,
        survivorKey: resolvedKey,
        loserKeys: mergedKeys,
        reason: merged ? "collide_merge" : "key_flip",
        contactId,
        logger,
      });
    }
    if (mergedIdentifiedKeys?.length) {
      logResidualTwins({
        survivorKey: resolvedKey,
        identifiedLoserKeys: mergedIdentifiedKeys,
        contactId,
        logger,
      });
    }
  }

  // (2c) Event mirror — best-effort `capture()` into the active analytics
  // provider, gated by operator policy. Placed on the fresh-insert side of the
  // idempotency guard (the duplicate path returned at the early `stored:false`
  // above), so a same-key retry NEVER double-mirrors — `capture` is NOT
  // idempotent, and this is the ONLY site that calls it on the ingest spine
  // (never a journey task). Provider + config fall back to the container
  // singletons so the mirror fires on EVERY ingest path, not just the routes
  // that thread `analytics`. `source === "posthog"` events are excluded
  // unconditionally (they came FROM PostHog — re-capturing them would loop).
  const mirrorProvider = analytics ?? getAnalytics();
  const mirrorConfig = eventMirror ?? getAnalyticsEventMirror();
  if (
    mirrorConfig?.enabled &&
    mirrorProvider?.capabilities.personWrites &&
    event.source !== "posthog" &&
    shouldMirrorEvent(event.event, mirrorConfig)
  ) {
    try {
      mirrorProvider.capture({
        distinctId: resolvedKey,
        event: event.event,
        // Group context rides the mirrored capture as `$groups` so PostHog (et
        // al.) can attribute the event to its account/team. Undefined when the
        // event carries no group association.
        groups: event.groups,
        // The revenue spine fans out with the event: `value`/`currency` ride as
        // plain properties so the analytics tool (PostHog et al.) can sum
        // revenue without a Hogsend round-trip. Property-bag keys of the same
        // name lose to the first-class columns.
        properties: {
          ...event.eventProperties,
          ...(value !== null
            ? { value, ...(currency ? { currency } : {}) }
            : {}),
        },
      });
    } catch (err) {
      logger.debug("event mirror capture failed (non-fatal)", {
        event: event.event,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // (2d) Sovereign group association — the STANDALONE (DB-first) path, run on
  // every ingest regardless of the analytics mirror config above. Ensures each
  // group row exists and upserts a `group_memberships` row for the resolved
  // contact (idempotent, no property write, no analytics). Placed on the
  // fresh-insert side of the idempotency guard (the duplicate path returned at
  // the early `stored:false`), so a same-key replay never re-associates.
  // Best-effort: the `user_events` row is already durably stored (the plain
  // path has NO idempotency key, so a thrown error + ingest retry would
  // DOUBLE-insert the event) — a group-write hiccup must never fail an
  // already-stored event.
  if (event.groups && Object.keys(event.groups).length > 0) {
    try {
      await associateGroups({ db, contactId, groups: event.groups });
    } catch (err) {
      logger.warn("group association failed (non-fatal)", {
        event: event.event,
        userId: resolvedKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // (3) Build the JSON-serializable subset of eventProperties for the Hatchet
  // push payload (scalars only — the SDK serializes the envelope).
  const serializableProperties = Object.fromEntries(
    Object.entries(event.eventProperties).filter(
      ([, v]) =>
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean" ||
        v === null,
    ),
  ) as Record<string, string | number | boolean | null>;

  // (4) Hatchet push + (5) checkExits, both keyed on the resolved key. The push
  // payload wire key STAYS `properties` (bucket tests assert on it — risk 9).
  //
  // An idempotency claim must not outlive a FAILED publish: journeys were never
  // notified, and the consumed key would make every retry a silent no-op (the
  // event becomes permanently invisible to journeys/destinations). So on a push
  // failure the just-inserted row is compensating-deleted before rethrowing —
  // the caller's retry (same key) can then re-claim and re-publish.
  const [pushResult, exitsResult] = await Promise.allSettled([
    hatchet.events.push(event.event, {
      userId: resolvedKey,
      userEmail: event.userEmail ?? "",
      properties: serializableProperties,
      // ENGINE-INTERNAL provenance: the resolved subject row id, so a journey
      // enrolling on this event can re-emit for the SAME subject by row id
      // (folds, never mints a twin). Additive/optional — consumers ignoring it
      // are unaffected.
      contactId,
    }),
    checkExits(db, registry, hatchet, logger, {
      userId: resolvedKey,
      eventName: event.event,
      properties: event.eventProperties,
    }),
  ]);
  if (pushResult.status === "rejected") {
    if (idempotentInsertId) {
      try {
        await db
          .delete(userEvents)
          .where(eq(userEvents.id, idempotentInsertId));
      } catch (cleanupErr) {
        logger.warn("ingestEvent: failed to roll back idempotency claim", {
          event: event.event,
          idempotencyKey: event.idempotencyKey,
          error:
            cleanupErr instanceof Error
              ? cleanupErr.message
              : String(cleanupErr),
        });
      }
    }
    throw pushResult.reason;
  }
  if (exitsResult.status === "rejected") {
    throw exitsResult.reason;
  }
  const exits = exitsResult.value;

  // (5b) Blueprint dispatch (spec §5) — the DB-driven twin of the Hatchet
  // push in (4): one `blueprint:run` per enabled matching blueprint. Runs
  // AFTER the main push settled, so a dispatched blueprint never observes an
  // event code journeys were not notified of. Best-effort by design: the
  // event row + code-journey push are already committed, so throwing here
  // could not be retried into a redelivery (the idempotency claim survives) —
  // it would only fail the caller for work that half-happened. Mirrors the
  // bucket-membership stance below.
  try {
    await checkBlueprintTriggers({
      db,
      hatchet,
      logger,
      event: {
        name: event.event,
        userId: resolvedKey,
        userEmail: event.userEmail ?? "",
        properties: serializableProperties,
      },
    });
  } catch (err) {
    logger.warn("Blueprint trigger dispatch failed", {
      event: event.event,
      userId: resolvedKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // (5c)+(5d) — the post-store hooks. Both fire only AFTER the push settled
  // (a failed publish compensating-deletes the event row, so a rolled-back
  // event never leaves a fired conversion or a moved deal behind) and only
  // on a FRESH insert (replays early-returned at (2)). Each is best-effort
  // in its own try/catch: the event is already durable, so a hook failure
  // warns rather than failing the caller.
  const hookEvent = insertedRow
    ? {
        name: event.event,
        source: event.source ?? null,
        properties: event.eventProperties,
        value,
        currency,
        occurredAt: insertedRow.occurredAt,
      }
    : null;

  // (5c) Conversion-point evaluation (plan §5.1) — the unique
  // (definition, event) index makes any replay a no-op.
  if (insertedRow && hookEvent) {
    try {
      const fired = await evaluateConversionsAtIngest({
        db,
        logger,
        registry: getConversionRegistry(),
        event: hookEvent,
        eventRowId: insertedRow.id,
        contactId,
        userKey: resolvedKey,
      });
      for (const firedConversion of fired) {
        // Fan fired conversions out to their ad-platform destinations
        // (§5.2) FIRST — the pending dispatch row is the recoverable
        // anchor, and the conversion row won't re-fire on replay, so
        // nothing may run ahead of it and throw. The deterministic
        // event_id is stable across retries AND re-evaluations.
        const destinationIds = firedConversion.definition.meta.destinations;
        if (destinationIds && destinationIds.length > 0) {
          await enqueueConversionDispatches({
            db,
            logger,
            conversionId: firedConversion.conversionId,
            eventId: conversionEventId({
              contactId,
              definitionId: firedConversion.definition.meta.id,
              eventRowId: insertedRow.id,
            }),
            destinationIds,
          });
        }

        // The attribution ledger (§6.1): every model's credits over the
        // contact's touchpoint path, written once at conversion time.
        // Pure reporting — individually isolated so a transient ledger
        // failure can never cost a dispatch or a later conversion.
        try {
          await recordAttributionCredits({
            db,
            logger,
            conversionId: firedConversion.conversionId,
            userKey: resolvedKey,
            value: firedConversion.value,
            currency: firedConversion.currency,
            occurredAt: insertedRow.occurredAt,
            windowDays:
              firedConversion.definition.meta.attributionWindowDays ?? 90,
            windows: firedConversion.definition.meta.windows,
          });
        } catch (err) {
          logger.warn("attribution credit write failed", {
            conversionId: firedConversion.conversionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.warn("Conversion evaluation failed", {
        event: event.event,
        userId: resolvedKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // (5d) Event-driven funnel stage transitions (event-native funnels). The
  // money events it mints (`deal.quoted`/`deal.sold`) recurse through
  // ingestEvent, bounded at define time: `deal.`/`funnel.`/`crm.` events
  // cannot be stage triggers.
  if (insertedRow && hookEvent) {
    const funnelRegistry = getCrmSyncConfig()?.funnels;
    if (funnelRegistry) {
      try {
        await applyFunnelTransitionsAtIngest({
          db,
          registry,
          hatchet,
          logger,
          analytics,
          funnels: funnelRegistry,
          event: hookEvent,
          eventRowId: insertedRow.id,
          contactId,
          userKey: resolvedKey,
        });
      } catch (err) {
        logger.warn("Funnel transition evaluation failed", {
          event: event.event,
          userId: resolvedKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // (5e) Funnel progression REPORTING projection (impact plan §3.3) —
      // first-reach `funnel_progress` rows over the SAME transition rules
      // and gates as the deal mover above, so the two projections never
      // disagree. Best-effort like every hook; the unique (contact, funnel,
      // stage) index makes any replay a no-op.
      try {
        await recordFunnelProgressAtIngest({
          db,
          logger,
          funnels: funnelRegistry,
          event: hookEvent,
          eventRowId: insertedRow.id,
          contactId,
          userKey: resolvedKey,
        });
      } catch (err) {
        logger.warn("Funnel progression write failed", {
          event: event.event,
          userId: resolvedKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // (6) Real-time bucket membership re-evaluation (Section 6.1). NOT part of the
  // Promise.all above: its property eval reads contact state ⊕ this-ingest
  // contactProperties patch, and its bucket:entered/left emissions recurse back
  // into ingestEvent (the recursion guard in checkBucketMembership bounds them).
  // Best-effort: a bucket failure must not fail the ingest of the originating
  // event.
  try {
    await checkBucketMembership({
      db,
      registry,
      hatchet,
      logger,
      userId: resolvedKey,
      userEmail: event.userEmail || null,
      event: event.event,
      eventProperties: event.eventProperties,
      contactProperties: event.contactProperties ?? {},
    });
  } catch (err) {
    logger.warn("Bucket membership check failed", {
      event: event.event,
      userId: resolvedKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info("Event ingested", {
    event: event.event,
    userId: resolvedKey,
    exits: exits.filter((e) => e.exited).length,
  });

  return { stored: true, exits, contactKey: resolvedKey };
}

async function checkExits(
  db: Database,
  registry: JourneyRegistry,
  hatchet: HatchetClient,
  logger: Logger,
  event: {
    userId: string;
    eventName: string;
    properties: Record<string, unknown>;
  },
): Promise<ExitResult[]> {
  const results: ExitResult[] = [];

  const activeStates = await db.query.journeyStates.findMany({
    where: and(
      eq(journeyStates.userId, event.userId),
      inArray(journeyStates.status, ["active", "waiting"]),
      isNull(journeyStates.deletedAt),
    ),
  });

  // Blueprint enrollments share journeyStates but are NOT in the code-journey
  // registry — their exitOn lives on the journey_blueprints row (spec §4).
  // Resolve exitOn for any active state whose journeyId the registry doesn't
  // know, in one batched read. Deliberately status-agnostic: disabling a
  // blueprint stops NEW enrollments, but an in-flight run keeps honoring its
  // exit rules (spec §10/§12).
  const unregisteredIds = [
    ...new Set(
      activeStates
        .map((state) => state.journeyId)
        .filter((journeyId) => !registry.get(journeyId)),
    ),
  ];
  const blueprintExitOn = new Map<string, NonNullable<JourneyMeta["exitOn"]>>();
  if (unregisteredIds.length > 0) {
    const rows = await db
      .select({ id: journeyBlueprints.id, exitOn: journeyBlueprints.exitOn })
      .from(journeyBlueprints)
      .where(inArray(journeyBlueprints.id, unregisteredIds));
    for (const row of rows) {
      if (row.exitOn?.length) {
        blueprintExitOn.set(
          row.id,
          row.exitOn as NonNullable<JourneyMeta["exitOn"]>,
        );
      }
    }
  }

  const statesToExit: string[] = [];
  const runIdsToCancel: string[] = [];

  for (const state of activeStates) {
    const exitOn =
      registry.get(state.journeyId)?.exitOn ??
      blueprintExitOn.get(state.journeyId);
    if (!exitOn) continue;

    const shouldExit = exitOn.some((exitCondition) => {
      if (exitCondition.event !== event.eventName) return false;
      if (!exitCondition.where?.length) return true;
      return evaluatePropertyConditions({
        conditions: exitCondition.where,
        properties: event.properties,
      });
    });

    if (shouldExit) {
      statesToExit.push(state.id);
      if (state.hatchetRunId) {
        runIdsToCancel.push(state.hatchetRunId);
      }
    }

    results.push({
      journeyId: state.journeyId,
      stateId: state.id,
      exited: shouldExit,
    });
  }

  if (statesToExit.length > 0) {
    await db
      .update(journeyStates)
      .set({
        status: "exited",
        exitedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(journeyStates.id, statesToExit));

    // Fire-and-forget EXIT transition logs (best-effort; the exit path is
    // already best-effort around the hatchet cancel below). Never throws.
    for (const id of statesToExit) {
      logTransition({
        db,
        journeyStateId: id,
        from: null,
        to: "end-exited",
        action: "exited",
      });
    }

    // Cancel the live durable runs so a journey suspended in a sleep or
    // `waitForEvent` can't resume and fire after it has exited. Best-effort: a
    // run may have already finished, and the in-run resume guard
    // (JourneyExitedError) is the backstop if a cancel races a resume.
    if (runIdsToCancel.length > 0) {
      try {
        await hatchet.runs.cancel({ ids: runIdsToCancel });
      } catch (err) {
        logger.warn("Failed to cancel exited journey runs", {
          count: runIdsToCancel.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return results;
}
