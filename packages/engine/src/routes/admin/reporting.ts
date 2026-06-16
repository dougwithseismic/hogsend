import { emailSends } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  and,
  count,
  desc,
  eq,
  gte,
  isNotNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { contactKey, resolveContact } from "../../lib/contacts.js";
import { rate, TRUNC_SQL } from "../../lib/metrics-sql.js";
import { errorSchema } from "../../lib/schemas.js";

// Filtered-count fragments shared by the per-template totals + series queries.
const COUNTS = {
  sent: sql<number>`count(*) filter (where ${emailSends.sentAt} is not null)`,
  delivered: sql<number>`count(*) filter (where ${emailSends.status} = 'delivered' or ${emailSends.deliveredAt} is not null)`,
  opened: sql<number>`count(*) filter (where ${emailSends.openedAt} is not null)`,
  clicked: sql<number>`count(*) filter (where ${emailSends.clickedAt} is not null)`,
  bounced: sql<number>`count(*) filter (where ${emailSends.bouncedAt} is not null)`,
  complained: sql<number>`count(*) filter (where ${emailSends.complainedAt} is not null)`,
} as const;

// ---------------------------------------------------------------------------
// GET /templates/{templateKey} — totals + time-series for one template
// ---------------------------------------------------------------------------

const templateSeriesRoute = createRoute({
  method: "get",
  path: "/templates/{templateKey}",
  tags: ["Admin — Reporting"],
  summary: "One template's totals + engagement time-series",
  request: {
    params: z.object({ templateKey: z.string() }),
    query: z.object({
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      granularity: z.enum(["day", "week", "month"]).default("day"),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            templateKey: z.string(),
            window: z.object({
              from: z.string().nullable(),
              to: z.string().nullable(),
            }),
            totals: z.object({
              sent: z.number(),
              delivered: z.number(),
              opened: z.number(),
              clicked: z.number(),
              bounced: z.number(),
              complained: z.number(),
              deliveryRate: z.number(),
              openRate: z.number(),
              clickRate: z.number(),
              clickToDeliveryRate: z.number(),
            }),
            series: z.array(
              z.object({
                date: z.string(),
                sent: z.number(),
                delivered: z.number(),
                opened: z.number(),
                clicked: z.number(),
                bounced: z.number(),
              }),
            ),
          }),
        },
      },
      description: "Template totals and time-series",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Template has never been sent",
    },
  },
});

// ---------------------------------------------------------------------------
// GET /contacts/{id}/activity — per-send engagement rows for one contact
// ---------------------------------------------------------------------------

const contactActivityRoute = createRoute({
  method: "get",
  path: "/contacts/{id}/activity",
  tags: ["Admin — Reporting"],
  summary: "A contact's email sends with engagement",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            contact: z.object({
              externalId: z.string().nullable(),
              email: z.string().nullable(),
            }),
            sends: z.array(
              z.object({
                id: z.string(),
                templateKey: z.string().nullable(),
                subject: z.string(),
                status: z.string(),
                sentAt: z.string().nullable(),
                deliveredAt: z.string().nullable(),
                openedAt: z.string().nullable(),
                clickedAt: z.string().nullable(),
                bouncedAt: z.string().nullable(),
                complainedAt: z.string().nullable(),
                bounceType: z.string().nullable(),
                createdAt: z.string(),
              }),
            ),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Per-contact email send activity",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Contact not found",
    },
  },
});

const MAX_EXPORT_ROWS = 50_000;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export const reportingRouter = new OpenAPIHono<AppEnv>()
  .openapi(templateSeriesRoute, async (c) => {
    const { db } = c.get("container");
    const { templateKey } = c.req.valid("param");
    const { from, to, granularity } = c.req.valid("query");

    const existing = await db
      .select({ id: emailSends.id })
      .from(emailSends)
      .where(eq(emailSends.templateKey, templateKey))
      .limit(1);
    if (existing.length === 0) {
      return c.json({ error: "Template has never been sent" }, 404);
    }

    const conditions = [eq(emailSends.templateKey, templateKey)];
    if (from) conditions.push(gte(emailSends.createdAt, new Date(from)));
    if (to) conditions.push(lte(emailSends.createdAt, new Date(to)));
    const where = and(...conditions);

    const trunc = sql`date_trunc(${TRUNC_SQL[granularity]}, ${emailSends.createdAt})`;

    const [totalsRows, seriesRows] = await Promise.all([
      db.select(COUNTS).from(emailSends).where(where),
      db
        .select({
          date: sql<string>`${trunc}::text`,
          sent: COUNTS.sent,
          delivered: COUNTS.delivered,
          opened: COUNTS.opened,
          clicked: COUNTS.clicked,
          bounced: COUNTS.bounced,
        })
        .from(emailSends)
        .where(where)
        .groupBy(trunc)
        .orderBy(trunc),
    ]);

    const t = totalsRows[0] ?? {
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
      complained: 0,
    };
    const sent = Number(t.sent);
    const delivered = Number(t.delivered);
    const opened = Number(t.opened);
    const clicked = Number(t.clicked);
    const openDenominator = delivered > 0 ? delivered : sent;

    return c.json(
      {
        templateKey,
        window: { from: from ?? null, to: to ?? null },
        totals: {
          sent,
          delivered,
          opened,
          clicked,
          bounced: Number(t.bounced),
          complained: Number(t.complained),
          deliveryRate: rate(delivered, sent),
          openRate: rate(opened, openDenominator),
          clickRate: rate(clicked, opened),
          clickToDeliveryRate: rate(clicked, delivered),
        },
        series: seriesRows.map((row) => ({
          date: row.date,
          sent: Number(row.sent),
          delivered: Number(row.delivered),
          opened: Number(row.opened),
          clicked: Number(row.clicked),
          bounced: Number(row.bounced),
        })),
      },
      200,
    );
  })
  .openapi(contactActivityRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");
    const { limit, offset } = c.req.valid("query");

    const contact = await resolveContact({ db, id });
    if (!contact) {
      return c.json({ error: "Contact not found" }, 404);
    }

    // Denormalized identity makes this single-table; fall back to the contact's
    // email so journeyless sends still surface.
    const idConds = [eq(emailSends.userId, contactKey(contact))];
    if (contact.email) idConds.push(eq(emailSends.userEmail, contact.email));
    const where = or(...idConds);

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(emailSends)
        .where(where)
        .orderBy(desc(emailSends.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(emailSends).where(where),
    ]);

    return c.json(
      {
        contact: { externalId: contact.externalId, email: contact.email },
        sends: rows.map((row) => ({
          id: row.id,
          templateKey: row.templateKey,
          subject: row.subject,
          status: row.status,
          sentAt: row.sentAt?.toISOString() ?? null,
          deliveredAt: row.deliveredAt?.toISOString() ?? null,
          openedAt: row.openedAt?.toISOString() ?? null,
          clickedAt: row.clickedAt?.toISOString() ?? null,
          bouncedAt: row.bouncedAt?.toISOString() ?? null,
          complainedAt: row.complainedAt?.toISOString() ?? null,
          bounceType: row.bounceType,
          createdAt: row.createdAt.toISOString(),
        })),
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
      },
      200,
    );
  });

// CSV export — plain route (non-JSON response) under the same auth as the rest
// of /v1/admin. Bounded to MAX_EXPORT_ROWS; same filters as GET /admin/emails.
reportingRouter.get("/sends/export", async (c) => {
  const { db } = c.get("container");
  const q = c.req.query();

  const engagementColumn = {
    opened: emailSends.openedAt,
    clicked: emailSends.clickedAt,
    bounced: emailSends.bouncedAt,
    complained: emailSends.complainedAt,
  } as const;

  const conditions = [];
  if (q.templateKey) conditions.push(eq(emailSends.templateKey, q.templateKey));
  if (q.status)
    conditions.push(
      eq(emailSends.status, q.status as typeof emailSends.$inferSelect.status),
    );
  if (q.category) conditions.push(eq(emailSends.category, q.category));
  if (q.userId) conditions.push(eq(emailSends.userId, q.userId));
  if (q.engagement && q.engagement in engagementColumn)
    conditions.push(
      isNotNull(
        engagementColumn[q.engagement as keyof typeof engagementColumn],
      ),
    );
  if (q.from) conditions.push(gte(emailSends.createdAt, new Date(q.from)));
  if (q.to) conditions.push(lte(emailSends.createdAt, new Date(q.to)));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(emailSends)
    .where(where)
    .orderBy(desc(emailSends.createdAt))
    .limit(MAX_EXPORT_ROWS);

  const header = [
    "id",
    "createdAt",
    "templateKey",
    "status",
    "toEmail",
    "userId",
    "subject",
    "sentAt",
    "deliveredAt",
    "openedAt",
    "clickedAt",
    "bouncedAt",
    "complainedAt",
    "bounceType",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.createdAt,
        r.templateKey,
        r.status,
        r.toEmail,
        r.userId,
        r.subject,
        r.sentAt,
        r.deliveredAt,
        r.openedAt,
        r.clickedAt,
        r.bouncedAt,
        r.complainedAt,
        r.bounceType,
      ]
        .map(csvCell)
        .join(","),
    );
  }

  // The export intentionally returns all matching sends, but is hard-capped at
  // MAX_EXPORT_ROWS. Signal when the result was truncated so a caller never
  // mistakes a partial CSV for the complete history.
  const truncated = rows.length >= MAX_EXPORT_ROWS;

  return c.body(lines.join("\n"), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="email-sends.csv"',
    ...(truncated
      ? {
          "X-Hogsend-Export-Truncated": "true",
          "X-Hogsend-Export-Limit": String(MAX_EXPORT_ROWS),
        }
      : {}),
  });
});
