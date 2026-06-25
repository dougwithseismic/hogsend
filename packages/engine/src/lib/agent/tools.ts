import { criteriaBuilder, days, evaluateCondition } from "@hogsend/core";
import {
  contacts,
  emailPreferences,
  emailSends,
  journeyStates,
  userEvents,
} from "@hogsend/db";
import { tool } from "ai";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { HogsendClient } from "../../container.js";
import {
  contactKey,
  contactSearchFilter,
  resolveContact,
} from "../contacts.js";
import { mintProposal } from "./proposals.js";
import { effectiveTier } from "./risk.js";

/**
 * The agent's tool set. READ tools auto-run (in-process against the container,
 * the same query the corresponding admin route runs). WRITE tools are MINT-ONLY:
 * their execute() builds a human summary, mints a single-use proposal token, and
 * returns `{ status: "needs_confirmation", ... }` — they NEVER perform the side
 * effect. The real write happens only in POST /v1/admin/agent/confirm.
 */
export function buildAgentTools({
  container,
  actorEmail,
  sessionId,
}: {
  container: HogsendClient;
  actorEmail: string;
  sessionId?: string;
}) {
  const { db, env, registry, bucketRegistry, domainStatus } = container;

  /**
   * Shared body for every write tool. NEVER performs the write. The recorded
   * tier is the EFFECTIVE tier at mint time (test-mode-aware) so the confirm
   * route can detect a test-mode change between propose and confirm. The args
   * are stored server-side in Redis and deliberately NOT returned to the browser.
   */
  const mintWrite = async (
    toolName: string,
    args: Record<string, unknown>,
    summary: string,
  ) => {
    const tier = effectiveTier(toolName, {
      testMode: domainStatus.testModeCached(),
    });
    const { proposalId, token, expiresAt } = await mintProposal({
      secret: env.BETTER_AUTH_SECRET,
      tool: toolName,
      args,
      tier,
      actorEmail,
      sessionId,
    });
    return {
      status: "needs_confirmation" as const,
      proposalId,
      token,
      tool: toolName,
      summary,
      tier,
      expiresAt,
    };
  };

  return {
    // ---- READ TOOLS (auto-run) ----------------------------------------------
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

    find_contacts: tool({
      description:
        "Search contacts by email / external id / anonymous id / discord id (substring match). Returns up to `limit` non-deleted contacts, most recently seen first.",
      inputSchema: z.object({
        search: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      execute: async ({ search, limit }) =>
        db
          .select({
            id: contacts.id,
            email: contacts.email,
            externalId: contacts.externalId,
            lastSeenAt: contacts.lastSeenAt,
          })
          .from(contacts)
          .where(and(contactSearchFilter(search), isNull(contacts.deletedAt)))
          .orderBy(desc(contacts.lastSeenAt))
          .limit(limit),
    }),

    get_contact: tool({
      description:
        "Fetch a single contact (by uuid or external id) plus its email preferences.",
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const contact = await resolveContact({ db, id });
        if (!contact) return { error: `No contact for "${id}"` };
        const prefs = await db
          .select()
          .from(emailPreferences)
          .where(eq(emailPreferences.userId, contact.externalId ?? contact.id))
          .limit(1);
        return { contact, preferences: prefs[0] ?? null };
      },
    }),

    get_contact_timeline: tool({
      description:
        "A contact's recent activity: events and journey enrollments. Pass the contact uuid or external id.",
      inputSchema: z.object({
        id: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ id, limit }) => {
        const contact = await resolveContact({ db, id });
        if (!contact) return { error: `No contact for "${id}"` };
        const key = contactKey(contact);
        const [events, journeys] = await Promise.all([
          db
            .select({
              event: userEvents.event,
              source: userEvents.source,
              occurredAt: userEvents.occurredAt,
            })
            .from(userEvents)
            .where(eq(userEvents.userId, key))
            .orderBy(desc(userEvents.occurredAt))
            .limit(limit),
          db
            .select({
              journeyId: journeyStates.journeyId,
              status: journeyStates.status,
              createdAt: journeyStates.createdAt,
            })
            .from(journeyStates)
            .where(
              and(
                eq(journeyStates.userId, key),
                isNull(journeyStates.deletedAt),
              ),
            )
            .orderBy(desc(journeyStates.createdAt))
            .limit(limit),
        ]);
        return { contactKey: key, events, journeys };
      },
    }),

    list_sends: tool({
      description:
        "List recent email sends, most recent first: template, recipient, status, and timestamps.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ limit }) =>
        db
          .select({
            id: emailSends.id,
            templateKey: emailSends.templateKey,
            to: emailSends.toEmail,
            status: emailSends.status,
            sentAt: emailSends.sentAt,
            openedAt: emailSends.openedAt,
            clickedAt: emailSends.clickedAt,
          })
          .from(emailSends)
          .orderBy(desc(emailSends.createdAt))
          .limit(limit),
    }),

    build_audience: tool({
      description:
        "Count contacts matching an ad-hoc criterion (a property comparison OR an event-occurred-within-window check). Returns the matched count and a sample of contact ids. Read-only — does NOT create a bucket or campaign. Scans up to 5000 contacts.",
      inputSchema: z.object({
        kind: z.enum(["property", "event"]),
        property: z.string().optional(),
        op: z
          .enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "exists"])
          .optional(),
        value: z.union([z.string(), z.number(), z.boolean()]).optional(),
        event: z.string().optional(),
        withinDays: z.number().int().min(1).max(365).optional(),
      }),
      execute: async (input) => {
        const condition =
          input.kind === "event"
            ? criteriaBuilder
                .event(input.event ?? "")
                .within(days(input.withinDays ?? 7))
                .exists()
            : (() => {
                const m = criteriaBuilder.prop(input.property ?? "");
                switch (input.op) {
                  case "exists":
                    return m.exists();
                  case "neq":
                    return m.neq(input.value ?? "");
                  case "gt":
                    return m.gt(Number(input.value));
                  case "gte":
                    return m.gte(Number(input.value));
                  case "lt":
                    return m.lt(Number(input.value));
                  case "lte":
                    return m.lte(Number(input.value));
                  case "contains":
                    return m.contains(input.value ?? "");
                  default:
                    return m.eq(input.value ?? "");
                }
              })();

        const all = await db
          .select()
          .from(contacts)
          .where(isNull(contacts.deletedAt))
          .limit(5000);
        const matched: string[] = [];
        for (const c of all) {
          const ok = await evaluateCondition({
            condition,
            ctx: {
              db,
              userId: contactKey(c),
              journeyContext: (c.properties ?? {}) as Record<string, unknown>,
            },
          });
          if (ok) matched.push(c.id);
        }
        return {
          count: matched.length,
          sample: matched.slice(0, 10),
          capped: all.length === 5000,
        };
      },
    }),

    // ---- WRITE TOOLS (mint-only — NO side effect here) -----------------------
    fire_event: tool({
      description:
        "Fire an event for a contact through the full ingest pipeline (triggers journeys/buckets). REQUIRES operator confirmation — returns a proposal, does not fire.",
      inputSchema: z.object({
        event: z.string().min(1),
        userId: z.string().optional(),
        userEmail: z.string().email().optional(),
        eventProperties: z.record(z.string(), z.unknown()).default({}),
      }),
      execute: async (args) =>
        mintWrite(
          "fire_event",
          args,
          `Fire event "${args.event}" for ${args.userEmail ?? args.userId ?? "(no recipient)"}`,
        ),
    }),

    send_transactional_email: tool({
      description:
        "Send one transactional email from a registered template to one recipient. REQUIRES confirmation — returns a proposal, does not send.",
      inputSchema: z.object({
        template: z.string().min(1),
        to: z.string().email(),
        props: z.record(z.string(), z.unknown()).default({}),
        subject: z.string().optional(),
        userId: z.string().optional(),
      }),
      execute: async (args) =>
        mintWrite(
          "send_transactional_email",
          args,
          `Send "${args.template}" to ${args.to}`,
        ),
    }),

    send_campaign: tool({
      description:
        "Broadcast a template to every subscribed member of a list OR every active member of a bucket. REQUIRES confirmation — returns a proposal, does not send.",
      inputSchema: z
        .object({
          name: z.string().optional(),
          list: z.string().optional(),
          bucket: z.string().optional(),
          template: z.string().min(1),
          props: z.record(z.string(), z.unknown()).default({}),
          subject: z.string().optional(),
          from: z.string().optional(),
        })
        .refine((b) => (b.list ? 1 : 0) + (b.bucket ? 1 : 0) === 1, {
          message: "Exactly one of `list` or `bucket` is required",
        }),
      execute: async (args) =>
        mintWrite(
          "send_campaign",
          args,
          `Broadcast "${args.template}" to ${args.list ? `list ${args.list}` : `bucket ${args.bucket}`}`,
        ),
    }),

    enroll_in_journey: tool({
      description:
        "Manually enroll a contact in a journey by firing its trigger event. REQUIRES confirmation.",
      inputSchema: z.object({
        journeyId: z.string().min(1),
        userId: z.string().optional(),
        userEmail: z.string().email().optional(),
        properties: z.record(z.string(), z.unknown()).default({}),
      }),
      execute: async (args) =>
        mintWrite(
          "enroll_in_journey",
          args,
          `Enroll ${args.userEmail ?? args.userId ?? "(no recipient)"} in journey ${args.journeyId}`,
        ),
    }),

    subscribe_list: tool({
      description:
        "Subscribe a contact to an email list (opt-in). REQUIRES confirmation.",
      inputSchema: z.object({
        list: z.string().min(1),
        userId: z.string().optional(),
        email: z.string().email().optional(),
      }),
      execute: async (args) =>
        mintWrite(
          "subscribe_list",
          args,
          `Subscribe ${args.email ?? args.userId} to list ${args.list}`,
        ),
    }),

    unsubscribe_list: tool({
      description:
        "Unsubscribe a contact from an email list (opt-out). REQUIRES confirmation.",
      inputSchema: z.object({
        list: z.string().min(1),
        userId: z.string().optional(),
        email: z.string().email().optional(),
      }),
      execute: async (args) =>
        mintWrite(
          "unsubscribe_list",
          args,
          `Unsubscribe ${args.email ?? args.userId} from list ${args.list}`,
        ),
    }),

    upsert_contact: tool({
      description:
        "Create or update a contact by email / external id, optionally setting properties. REQUIRES confirmation.",
      inputSchema: z.object({
        userId: z.string().optional(),
        email: z.string().email().optional(),
        anonymousId: z.string().optional(),
        properties: z.record(z.string(), z.unknown()).default({}),
      }),
      execute: async (args) =>
        mintWrite(
          "upsert_contact",
          args,
          `Upsert contact ${args.email ?? args.userId ?? args.anonymousId}`,
        ),
    }),

    update_contact: tool({
      description:
        "Update an existing contact's email and/or properties (by uuid or external id). REQUIRES confirmation.",
      inputSchema: z.object({
        id: z.string().min(1),
        email: z.string().email().optional(),
        properties: z.record(z.string(), z.unknown()).default({}),
      }),
      execute: async (args) =>
        mintWrite("update_contact", args, `Update contact ${args.id}`),
    }),

    delete_contact: tool({
      description:
        "Soft-delete a contact (sets deletedAt). DESTRUCTIVE — requires confirmation.",
      inputSchema: z.object({
        email: z.string().email().optional(),
        userId: z.string().optional(),
      }),
      execute: async (args) =>
        mintWrite(
          "delete_contact",
          args,
          `Delete contact ${args.email ?? args.userId}`,
        ),
    }),
  };
}
