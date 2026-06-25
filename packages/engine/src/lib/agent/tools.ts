import { contacts, journeyStates, userEvents } from "@hogsend/db";
import { tool } from "ai";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { HogsendClient } from "../../container.js";

/**
 * The agent's tool set. Phase 0 ships READ-ONLY tools that prove the GLM-5.2
 * tool-use loop end-to-end against the live instance: each runs the SAME query
 * the corresponding admin route runs, in-process via the container. Write tools
 * (gated by the server-enforced proposal-token HITL) land in Phase 1.
 */
export function buildAgentTools({ container }: { container: HogsendClient }) {
  const { db, registry, bucketRegistry } = container;

  return {
    list_journeys: tool({
      description:
        "List the journeys (lifecycle email sequences) registered in this Hogsend instance: id, name, whether enabled, and the event that triggers each.",
      inputSchema: z.object({}),
      execute: async () =>
        registry.getAll().map((j) => ({
          id: j.id,
          name: j.name,
          enabled: j.enabled,
          trigger: j.trigger?.event,
        })),
    }),

    list_buckets: tool({
      description:
        "List the buckets (real-time segments) registered in this instance: id and name.",
      inputSchema: z.object({}),
      execute: async () =>
        bucketRegistry.getAll().map((b) => ({ id: b.id, name: b.name })),
    }),

    overview_stats: tool({
      description:
        "High-level instance stats: total (non-deleted) contacts and the count of active/waiting journey enrollments right now.",
      inputSchema: z.object({}),
      execute: async () => {
        const [totalContacts, activeJourneyEnrollments] = await Promise.all([
          db
            .select({ c: count() })
            .from(contacts)
            .where(isNull(contacts.deletedAt))
            .then((r) => r[0]?.c ?? 0),
          db
            .select({ c: count() })
            .from(journeyStates)
            .where(
              and(
                inArray(journeyStates.status, ["active", "waiting"]),
                isNull(journeyStates.deletedAt),
              ),
            )
            .then((r) => r[0]?.c ?? 0),
        ]);
        return { totalContacts, activeJourneyEnrollments };
      },
    }),

    query_events: tool({
      description:
        "List recently ingested events, most recent first. Optionally filter by exact event name (e.g. 'checkout.completed'). Use this to investigate what users have done.",
      inputSchema: z.object({
        event: z.string().optional().describe("exact event name to filter by"),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      execute: async ({ event, limit }) => {
        const where = event ? eq(userEvents.event, event) : undefined;
        return db
          .select({
            event: userEvents.event,
            userId: userEvents.userId,
            source: userEvents.source,
            occurredAt: userEvents.occurredAt,
          })
          .from(userEvents)
          .where(where)
          .orderBy(desc(userEvents.occurredAt))
          .limit(limit);
      },
    }),
  };
}
