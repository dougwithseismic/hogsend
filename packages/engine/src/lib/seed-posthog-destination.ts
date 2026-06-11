import { type Database, webhookEndpoints } from "@hogsend/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Logger } from "./logger.js";

/**
 * Transaction-scoped advisory-lock key serializing the single-tenant PostHog
 * seed across concurrent API + worker boots. An arbitrary fixed constant within
 * int4 range (the single-arg `pg_advisory_xact_lock` overload casts to bigint).
 */
const SEED_ADVISORY_LOCK_KEY = 1426198835;

/**
 * The email funnel a seeded PostHog destination subscribes to — the full
 * lifecycle that reaches PostHog on NO path before this destination existed.
 */
const POSTHOG_FUNNEL_EVENTS = [
  "email.sent",
  "email.delivered",
  "email.opened",
  "email.clicked",
  "email.action",
  "email.bounced",
  "email.complained",
] as const;

/**
 * Idempotently seed ONE `kind="posthog"` webhook endpoint subscribed to the
 * email funnel, so the full email lifecycle fans out to PostHog DURABLY on the
 * delivery spine.
 *
 * Guarded against duplicates: it inserts only when no single-tenant
 * (`organization_id IS NULL`) `kind="posthog"` endpoint already exists. Safe to
 * call from BOTH the API and worker boots (both build the client) — the second
 * caller finds the row and no-ops. Fire-and-forget at the call site: a transient
 * seed failure must never block boot.
 */
export async function seedPostHogDestination(opts: {
  db: Database;
  logger: Logger;
  apiKey: string;
  host?: string;
}): Promise<{ seeded: boolean }> {
  const { db, logger, apiKey, host } = opts;

  // Serialize the check-then-insert across concurrent API + worker boots (both
  // build the client) with a transaction-scoped advisory lock, so the race can
  // never double-seed. A per-endpoint unique constraint is intentionally avoided
  // — operators may legitimately create multiple PostHog endpoints by hand.
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${SEED_ADVISORY_LOCK_KEY})`,
    );

    const existing = await tx
      .select({
        id: webhookEndpoints.id,
        url: webhookEndpoints.url,
        eventTypes: webhookEndpoints.eventTypes,
      })
      .from(webhookEndpoints)
      .where(
        and(
          isNull(webhookEndpoints.organizationId),
          eq(webhookEndpoints.kind, "posthog"),
        ),
      )
      .limit(1);

    const found = existing[0];
    if (found) {
      // Reconcile the ENGINE-seeded row (identified by its sentinel URL) when
      // the funnel list has grown since it was inserted — its stored
      // eventTypes are a snapshot, and emitOutbound matches by jsonb
      // containment, so a pre-upgrade row would silently never receive newer
      // events (e.g. email.action). Operator-created endpoints are left
      // untouched: subscriber-chooses-events is the contract there.
      if (found.url === "posthog://capture") {
        const current = Array.isArray(found.eventTypes)
          ? (found.eventTypes as string[])
          : [];
        const missing = POSTHOG_FUNNEL_EVENTS.filter(
          (e) => !current.includes(e),
        );
        if (missing.length > 0) {
          await tx
            .update(webhookEndpoints)
            .set({
              eventTypes: [...current, ...missing],
              updatedAt: new Date(),
            })
            .where(eq(webhookEndpoints.id, found.id));
          logger.info("Reconciled seeded PostHog destination event types", {
            added: missing,
          });
        }
      }
      return { seeded: false };
    }

    await tx.insert(webhookEndpoints).values({
      url: "posthog://capture",
      description:
        "Auto-seeded PostHog destination (ENABLE_POSTHOG_DESTINATION)",
      kind: "posthog",
      config: {
        apiKey,
        ...(host ? { host } : {}),
        // Preserve continuity with the legacy fire-and-forget PostHog path,
        // which captured clicks as "email.link_clicked"; the posthog transform
        // remaps the canonical "email.clicked" back so existing PostHog funnels
        // keep working after the cutover.
        eventNames: { "email.clicked": "email.link_clicked" },
      },
      eventTypes: [...POSTHOG_FUNNEL_EVENTS],
      secret: null,
      secretPrefix: null,
      disabled: false,
    });

    logger.info("Seeded PostHog destination on the outbound spine", {
      events: POSTHOG_FUNNEL_EVENTS.length,
    });
    return { seeded: true };
  });
}
