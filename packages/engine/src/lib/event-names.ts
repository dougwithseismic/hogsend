/**
 * Event-name vocabulary — the merged observed + declared listing shared by
 * the agent tools (`mcp/blueprint-tools.ts` `list_events`) and the admin
 * route (`GET /v1/admin/events/names`). One runtime implementation (the
 * same lib-delegation pattern the other blueprint tools follow via
 * `lib/blueprints.ts`), so the two surfaces — including the note text —
 * can never drift.
 *
 * Event names are an OPEN vocabulary (no closed registry exists anywhere in
 * the engine — same as code journeys): this merges events actually observed
 * in `user_events` (occurrence counts, most recently seen first) with events
 * referenced as code-journey or blueprint triggers. Any other name is also
 * valid — it just hasn't been seen yet.
 */
import { journeyBlueprints, userEvents } from "@hogsend/db";
import { z } from "@hono/zod-openapi";
import { count, desc, ilike, inArray, max, min } from "drizzle-orm";
import type { HogsendClient } from "../container.js";

/**
 * One merged event-name entry. Canonical shape shared by the helper's return,
 * the `list_events` tool, and the `GET /v1/admin/events/names` OpenAPI response
 * (the route imports this instead of re-declaring it, so they can never drift).
 */
export const eventNameEntrySchema = z.object({
  name: z.string(),
  occurrences: z.number(),
  firstSeenAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  // Where the name is declared as a trigger: "journey:<id>" for code journeys,
  // "blueprint:<id> (<status>)" for blueprints.
  usedBy: z.array(z.string()),
});

export type EventNameEntry = z.infer<typeof eventNameEntrySchema>;

const EVENT_NAMES_NOTE =
  "Event names are an open vocabulary — this is observed + declared usage, not a closed registry. " +
  "Reserved namespaces (email.*, journey.*, bucket.*, contact.*, deal.*, funnel.*) are engine-emitted; don't use them as blueprint trigger events.";

export async function listEventNameVocabulary(opts: {
  db: HogsendClient["db"];
  registry: HogsendClient["registry"];
  /** Case-insensitive substring filter on the event name. */
  search?: string;
  /** Cap on the observed-events scan (the declared merge is uncapped). */
  limit: number;
}): Promise<{ note: string; events: EventNameEntry[] }> {
  const { db, registry, search, limit } = opts;

  // Observed vocabulary — grouped scan of user_events, recency-first. ilike
  // special chars are escaped so a search of "100%" matches literally
  // instead of becoming a wildcard. The blueprint-trigger select is
  // independent of it, so both go out in one round-trip.
  const escaped = search?.replace(/[\\%_]/g, (m) => `\\${m}`);
  const lastSeen = max(userEvents.occurredAt);
  const [observed, blueprintRows] = await Promise.all([
    db
      .select({
        name: userEvents.event,
        occurrences: count(),
        firstSeenAt: min(userEvents.occurredAt),
        lastSeenAt: lastSeen,
      })
      .from(userEvents)
      .where(escaped ? ilike(userEvents.event, `%${escaped}%`) : undefined)
      .groupBy(userEvents.event)
      .orderBy(desc(lastSeen))
      .limit(limit),
    db
      .select({
        id: journeyBlueprints.id,
        triggerEvent: journeyBlueprints.triggerEvent,
        status: journeyBlueprints.status,
      })
      .from(journeyBlueprints),
  ]);

  const byName = new Map<string, EventNameEntry>();
  for (const row of observed) {
    byName.set(row.name, {
      name: row.name,
      occurrences: Number(row.occurrences),
      firstSeenAt: row.firstSeenAt?.toISOString() ?? null,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      usedBy: [],
    });
  }

  const matches = (name: string) =>
    !search || name.toLowerCase().includes(search.toLowerCase());
  const entryFor = (name: string): EventNameEntry => {
    const existing = byName.get(name);
    if (existing) return existing;
    const created: EventNameEntry = {
      name,
      occurrences: 0,
      firstSeenAt: null,
      lastSeenAt: null,
      usedBy: [],
    };
    byName.set(name, created);
    return created;
  };

  // Declared vocabulary — code-journey triggers (never observed rows if
  // nothing fired yet) and blueprint triggers, labeled by consumer.
  for (const journey of registry.getAll()) {
    const event = journey.trigger?.event;
    if (!event || !matches(event)) continue;
    entryFor(event).usedBy.push(`journey:${journey.id}`);
  }
  for (const bp of blueprintRows) {
    if (!matches(bp.triggerEvent)) continue;
    entryFor(bp.triggerEvent).usedBy.push(`blueprint:${bp.id} (${bp.status})`);
  }

  // A declared trigger (registry/blueprint) can have real rows in user_events
  // that fell OUTSIDE the recency-capped observed scan above — it would then
  // read `occurrences: 0 / lastSeenAt: null`, misreporting a busy event as
  // never-fired. Observed rows always count >= 1, so `occurrences === 0` marks
  // exactly the declared-only entries. Backfill their true counts with ONE
  // targeted, bounded query (declared names are few — the code-journey +
  // blueprint trigger set, not the open vocabulary).
  const zeroNames = [...byName.values()]
    .filter((e) => e.occurrences === 0)
    .map((e) => e.name);
  if (zeroNames.length > 0) {
    const backfill = await db
      .select({
        name: userEvents.event,
        occurrences: count(),
        firstSeenAt: min(userEvents.occurredAt),
        lastSeenAt: max(userEvents.occurredAt),
      })
      .from(userEvents)
      .where(inArray(userEvents.event, zeroNames))
      .groupBy(userEvents.event);
    for (const row of backfill) {
      const entry = byName.get(row.name);
      if (!entry) continue;
      entry.occurrences = Number(row.occurrences);
      entry.firstSeenAt = row.firstSeenAt?.toISOString() ?? null;
      entry.lastSeenAt = row.lastSeenAt?.toISOString() ?? null;
    }
  }

  return { note: EVENT_NAMES_NOTE, events: [...byName.values()] };
}
