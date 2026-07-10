/**
 * `hogsend_report` — the single read tool. Every question about a Hogsend
 * instance routes through one scope-dispatched call, so the model never
 * choreographs multi-endpoint fishing expeditions (the server does the joins).
 */

import { z } from "zod";
import type { AdminClient } from "../client.js";
import {
  type DeliverabilityPoint,
  deadTriggerFindings,
  deliverabilityFindings,
  type Finding,
  funnelFindings,
  type JourneyFunnel,
  type JourneyListItem,
  parkedNodeFindings,
  type ReadinessCheck,
  readinessFindings,
  type TemplateMetricsRow,
  templateFindings,
} from "../lib/findings.js";
import {
  deepLink,
  nodeTable,
  pct,
  renderFindings,
  sortFindings,
  truncateHtml,
} from "../lib/format.js";
import { graphWalkthrough, specWalkthrough } from "../lib/walkthrough.js";
import { type ToolDef, toolError, toolResult } from "../registry.js";

// --- admin API response fragments (only the fields we read) ------------------

interface JourneysListResponse {
  journeys: JourneyListItem[];
  total: number;
}

interface GraphResponse {
  graph: {
    nodes: Array<{
      id: string;
      type: string;
      title?: string;
      subtitle?: string;
    }>;
  };
  metrics: {
    enrolled: number;
    terminals: { completed: number; failed: number; exited: number };
    nodes: Record<
      string,
      { live: number; failed: number; templateKey?: string }
    >;
  };
}

interface SpecDoc {
  summary: { version: number; enabled: boolean };
  spec: Record<string, unknown>;
}

const WINDOW_DAYS = { "7d": 7, "30d": 30, "90d": 90 } as const;
type Window = keyof typeof WINDOW_DAYS;

function windowFrom(window: Window): string {
  const ms = WINDOW_DAYS[window] * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms).toISOString();
}

/** Run `fn` over items with bounded concurrency; failures yield null. */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<R | null>> {
  const results: Array<R | null> = new Array(items.length).fill(null);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        const item = items[i];
        if (item === undefined) continue;
        try {
          results[i] = await fn(item);
        } catch {
          results[i] = null; // partial tolerance: degrade, don't fail the report
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// --- scope handlers -----------------------------------------------------------

async function healthScope(
  client: AdminClient,
  window: Window,
): Promise<ReturnType<typeof toolResult>> {
  const from = windowFrom(window);
  const link = (p: string) => deepLink(client.baseUrl, p);

  const [overview, journeysRes, emailRows, deliverability, readiness] =
    await Promise.all([
      client.get<Record<string, number>>("/v1/admin/metrics/overview"),
      client.get<JourneysListResponse>("/v1/admin/journeys", { limit: 100 }),
      client
        .get<{ templates: TemplateMetricsRow[] }>("/v1/admin/metrics/emails", {
          from,
        })
        .catch(() => ({ templates: [] as TemplateMetricsRow[] })),
      client
        .get<{ points: DeliverabilityPoint[] }>(
          "/v1/admin/metrics/emails/deliverability",
          { from },
        )
        .catch(() => ({ points: [] as DeliverabilityPoint[] })),
      client
        .get<{ checks: ReadinessCheck[] }>("/v1/admin/readiness")
        .catch(() => ({ checks: [] as ReadinessCheck[] })),
    ]);

  // Per-journey drill-down for the busiest enabled journeys (top 20 by total
  // enrollments) — capped fan-out to stay inside the engine's rate limit.
  const ranked = journeysRes.journeys
    .filter((j) => j.enabled)
    .map((j) => ({
      j,
      total:
        j.counts.active +
        j.counts.waiting +
        j.counts.completed +
        j.counts.failed +
        j.counts.exited,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);

  const findings: Finding[] = [];
  findings.push(...deadTriggerFindings(journeysRes.journeys, link));
  findings.push(...templateFindings(emailRows.templates ?? [], link));
  findings.push(...deliverabilityFindings(deliverability.points ?? []));
  findings.push(...readinessFindings(readiness.checks ?? []));

  const perJourney = await mapBounded(ranked, 5, async ({ j }) => {
    const [graph, funnel] = await Promise.all([
      client.get<GraphResponse>(`/v1/admin/journeys/${j.id}/graph`),
      client.get<JourneyFunnel>(`/v1/admin/metrics/journeys/${j.id}`),
    ]);
    return { j, graph, funnel };
  });
  for (const row of perJourney) {
    if (!row) continue;
    findings.push(
      ...parkedNodeFindings(
        row.j.id,
        row.j.name,
        {
          nodes: row.graph.graph.nodes,
          enrolled: row.graph.metrics.enrolled,
          nodeMetrics: row.graph.metrics.nodes,
        },
        link,
      ),
    );
    findings.push(...funnelFindings(row.j.id, row.j.name, row.funnel, link));
  }

  const sorted = sortFindings(findings);
  const summary =
    `Health report (${window}): ${sorted.length} finding(s) across ` +
    `${ranked.length} active journeys, ${overview.totalContacts ?? 0} contacts, ` +
    `${overview.emailsSent30d ?? 0} emails sent in 30d.`;

  return toolResult(`${summary}\n\n${renderFindings(sorted)}`, {
    summary,
    window,
    generatedAt: new Date().toISOString(),
    overview,
    findings: sorted,
  });
}

async function journeyScope(
  client: AdminClient,
  id: string,
): Promise<ReturnType<typeof toolResult>> {
  const [detail, graph, funnel, specDoc] = await Promise.all([
    client.get<{ journey: Record<string, unknown> }>(
      `/v1/admin/journeys/${id}`,
    ),
    client.get<GraphResponse>(`/v1/admin/journeys/${id}/graph`),
    client
      .get<JourneyFunnel>(`/v1/admin/metrics/journeys/${id}`)
      .catch(() => null),
    client.get<SpecDoc>(`/v1/admin/journey-specs/${id}`).catch(() => null), // 404 = code journey
  ]);

  const walkthrough = specDoc
    ? // biome-ignore lint/suspicious/noExplicitAny: validated server-side; narrated textually
      specWalkthrough(specDoc.spec as any)
    : graphWalkthrough(graph.graph.nodes);

  const funnelText = funnel
    ? `Funnel: enrolled ${funnel.enrolled} → sent ${funnel.emailSent} → opened ${funnel.emailOpened} (${pct(funnel.emailOpened, funnel.emailSent)}%) → clicked ${funnel.emailClicked} (${pct(funnel.emailClicked, funnel.emailOpened)}%) → completed ${funnel.completed}. Failed ${funnel.failed}, exited ${funnel.exited}.`
    : "Funnel: no data yet.";

  const origin = specDoc
    ? `Data-defined (JSON spec, version ${specDoc.summary.version}, ${specDoc.summary.enabled ? "ENABLED" : "disabled"} — editable + rollback-able via manage_journey)`
    : "Code-defined (managed in the repo; read-only from here except enable/disable)";

  const text = [
    `Journey "${id}" — ${origin}`,
    "",
    "What it does:",
    walkthrough,
    "",
    funnelText,
    "",
    "Where users are right now (live) and where they failed:",
    nodeTable(graph.graph.nodes, graph.metrics.nodes),
    "",
    `Studio: ${deepLink(client.baseUrl, `/journeys/${id}`)}`,
  ].join("\n");

  return toolResult(text, {
    journey: detail.journey,
    graph: graph.graph,
    metrics: graph.metrics,
    funnel,
    spec: specDoc?.spec ?? null,
    specVersion: specDoc?.summary.version ?? null,
  });
}

async function templateScope(
  client: AdminClient,
  id: string,
): Promise<ReturnType<typeof toolResult>> {
  const [preview, metrics] = await Promise.all([
    client.get<{ key: string; subject: string; html?: string; text?: string }>(
      `/v1/admin/templates/${id}/preview`,
    ),
    client
      .get<{ templates: TemplateMetricsRow[] }>("/v1/admin/metrics/emails")
      .catch(() => ({ templates: [] as TemplateMetricsRow[] })),
  ]);
  const row = metrics.templates?.find((t) => t.templateKey === id);
  const engagement = row
    ? `Engagement: ${row.sent} sent, ${row.openRate}% open, ${row.clickRate}% click, ${row.bounced} bounced.`
    : "Engagement: never sent.";
  return toolResult(
    [
      `Template "${id}"`,
      `Subject: ${preview.subject}`,
      engagement,
      "",
      preview.text
        ? `Plain text:\n${preview.text.slice(0, 1200)}`
        : `HTML (truncated):\n${truncateHtml(preview.html ?? "")}`,
    ].join("\n"),
    { preview, engagement: row ?? null },
  );
}

async function contactScope(
  client: AdminClient,
  id: string,
): Promise<ReturnType<typeof toolResult>> {
  // Accept an email, external id, or contact uuid — search resolves all three.
  const search = await client.get<{ contacts: Array<Record<string, unknown>> }>(
    "/v1/admin/contacts",
    { search: id, limit: 5 },
  );
  const contact = search.contacts?.[0];
  if (!contact) return toolError(`No contact found matching "${id}".`);
  const contactId = String(contact.id);
  const timeline = await client
    .get<{ items: Array<Record<string, unknown>> }>(
      `/v1/admin/contacts/${contactId}/timeline`,
      { limit: 30 },
    )
    .catch(() => ({ items: [] as Array<Record<string, unknown>> }));
  const timelineText = (timeline.items ?? [])
    .slice(0, 30)
    .map(
      (t) =>
        `- ${t.occurredAt ?? t.createdAt ?? ""} ${t.type ?? ""} ${t.title ?? t.event ?? ""}`,
    )
    .join("\n");
  return toolResult(
    [
      `Contact: ${contact.email ?? contact.externalId ?? contactId}`,
      `Properties: ${JSON.stringify(contact.properties ?? {})}`,
      "",
      "Recent activity:",
      timelineText || "(none)",
    ].join("\n"),
    { contact, timeline: timeline.items ?? [] },
  );
}

async function catalogScope(
  client: AdminClient,
): Promise<ReturnType<typeof toolResult>> {
  const [journeysRes, templates] = await Promise.all([
    client.get<JourneysListResponse>("/v1/admin/journeys", { limit: 100 }),
    client.get<{ templates: Array<{ key: string; category?: string | null }> }>(
      "/v1/admin/templates",
    ),
  ]);
  const journeyLines = journeysRes.journeys.map((j) => {
    const total =
      j.counts.active +
      j.counts.waiting +
      j.counts.completed +
      j.counts.failed +
      j.counts.exited;
    return `- ${j.id} (${j.enabled ? "enabled" : "disabled"}, trigger: ${j.trigger.event}, ${total} enrollments)`;
  });
  const templateLines = (templates.templates ?? []).map(
    (t) => `- ${t.key}${t.category ? ` [${t.category}]` : ""}`,
  );
  return toolResult(
    [
      `Journeys (${journeyLines.length}):`,
      ...journeyLines,
      "",
      `Email templates (${templateLines.length}) — valid \`template\` keys for journey specs:`,
      ...templateLines,
    ].join("\n"),
    { journeys: journeysRes.journeys, templates: templates.templates ?? [] },
  );
}

// --- the tool -----------------------------------------------------------------

export const reportTool: ToolDef = {
  name: "hogsend_report",
  title: "Hogsend report",
  tier: "read",
  description: [
    "Read anything about the Hogsend instance in one call. Scopes:",
    '- "health" (default): full marketing audit — ranked findings (bottlenecks where users are parked, funnel drop-offs, underperforming templates, deliverability risks, dead triggers, setup gaps). Start here for questions like "what\'s wrong" / "find bottlenecks" / "why did opens drop".',
    '- "journey" + id: everything about one journey — plain-English walkthrough, funnel, and exactly where users are parked or failing right now.',
    '- "template" + id (template key): rendered preview (subject/body) + engagement history.',
    '- "contact" + id (email, external id, or uuid): profile + recent activity timeline.',
    '- "catalog": cheap list of all journey ids and template keys — fetch this before authoring a journey spec.',
    "Returns compact text plus full data in structuredContent.",
  ].join("\n"),
  inputSchema: {
    scope: z
      .enum(["health", "journey", "template", "contact", "catalog"])
      .optional()
      .describe("What to report on. Default: health"),
    id: z
      .string()
      .optional()
      .describe("Required for journey/template/contact scopes"),
    window: z
      .enum(["7d", "30d", "90d"])
      .optional()
      .describe("Time window for health metrics. Default: 30d"),
  },
  handler: async (args, client) => {
    const scope = (args.scope as string | undefined) ?? "health";
    const id = args.id as string | undefined;
    const window = ((args.window as string | undefined) ?? "30d") as Window;

    switch (scope) {
      case "health":
        return healthScope(client, window);
      case "catalog":
        return catalogScope(client);
      case "journey":
        if (!id)
          return toolError(
            'scope "journey" requires `id` (journey id — see scope "catalog")',
          );
        return journeyScope(client, id);
      case "template":
        if (!id)
          return toolError(
            'scope "template" requires `id` (template key — see scope "catalog")',
          );
        return templateScope(client, id);
      case "contact":
        if (!id)
          return toolError(
            'scope "contact" requires `id` (email, external id, or uuid)',
          );
        return contactScope(client, id);
      default:
        return toolError(`Unknown scope "${scope}"`);
    }
  },
};
