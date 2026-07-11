/**
 * `hogsend_report` — a read-only health/observability report over the admin
 * REST API. Each `scope` fetches the routes it needs and runs the PURE
 * heuristics in `../lib/findings.ts` over the results. The tool does the I/O;
 * `findings.ts` does the (unit-tested) computation.
 *
 * The report envelope carries the caller identity (`GET /v1/admin/api-keys/self`)
 * so the output is self-describing about whose credential produced it. Expected
 * failures (a route 401s, the API is unreachable, …) come back as the shared
 * discriminated `{ ok: false, code }` result, never a throw.
 */
import { z } from "zod";
import type { AdminClient } from "../lib/admin-client.js";
import {
  type BlueprintListItem,
  type DeliverabilityPoint,
  deadBlueprintTriggerFindings,
  deadJourneyTriggerFindings,
  deliverabilityFindings,
  type Finding,
  type FunnelEntry,
  funnelFindings,
  type JourneyListItem,
  type JourneyMetric,
  type Readiness,
  readinessFindings,
  type Severity,
} from "../lib/findings.js";
import { mapHttpError } from "../lib/result.js";
import { defineTool, type McpTool } from "../lib/tool.js";

const NAME = "hogsend_report";

/**
 * Max per-journey funnel fetches before we stop and note the cap (no silent
 * truncation). Kept low because each fetch is a separate admin sub-request
 * against the caller's rate budget — the journeys scope already costs 2 list
 * calls + this many funnel calls, so a big number could self-throttle a busy
 * key. The top-enrolled journeys are scanned first, so the cap keeps the most
 * signal.
 */
const MAX_FUNNEL_FETCHES = 10;
/** List page size (the admin pagination max). */
const LIST_LIMIT = 100;

const reportShape = {
  scope: z
    .enum(["health", "blueprints", "journeys", "deliverability", "catalog"])
    .describe(
      "health (setup readiness) · blueprints (dead blueprint triggers) · " +
        "journeys (dead journey triggers + funnel drop-off) · deliverability " +
        "(bounce/complaint/delivery + per-template funnel) · catalog " +
        "(template keys + observed event names — a vocabulary listing, not findings).",
    ),
} satisfies z.ZodRawShape;

const description =
  "Read-only Hogsend health report. Pick a `scope`: health surfaces incomplete " +
  "setup; blueprints and journeys flag dead triggers (enabled but never enrolls) " +
  "and low send→open→click funnels; deliverability flags bounce/complaint/delivery " +
  "problems; catalog lists the registered template keys and observed event names " +
  "for authoring. Findings carry severity/evidence/suggested_action; thresholds are " +
  "conservative. The envelope includes the calling credential's identity. " +
  "Each report makes several admin API calls under the hood (the journeys scope " +
  "fans out per-journey funnel fetches), all against the key's rate budget — so " +
  "prefer one scoped report over rapid repeats. " +
  "Read-only in effect, but the Hogsend admin API authorizes every call at the " +
  "full-admin scope — a lesser key is rejected with 403.";

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}

/** Uniform per-scope result: findings plus optional coverage notes. */
interface ScopeResult {
  findings: Finding[];
  notes?: string[];
}

// --- Route response subsets ---
interface BlueprintListResponse {
  blueprints: BlueprintListItem[];
  total: number;
}
interface JourneyListResponse {
  journeys: JourneyListItem[];
  total: number;
}
interface JourneyMetricsResponse {
  journeys: JourneyMetric[];
}
interface JourneyFunnelResponse {
  journeyId: string;
  emailSent: number;
  emailOpened: number;
  emailClicked: number;
}
interface EmailMetricsResponse {
  templates: {
    templateKey: string;
    sent: number;
    opened: number;
    clicked: number;
  }[];
}
interface DeliverabilityResponse {
  points: DeliverabilityPoint[];
}
interface TemplatesResponse {
  templates: unknown[];
}
interface EventNamesResponse {
  note: string;
  events: unknown[];
}

async function healthScope(client: AdminClient): Promise<ScopeResult> {
  const readiness = await client.get<Readiness>("/v1/admin/readiness");
  return { findings: readinessFindings(readiness) };
}

async function blueprintsScope(client: AdminClient): Promise<ScopeResult> {
  const res = await client.get<BlueprintListResponse>("/v1/admin/blueprints", {
    limit: LIST_LIMIT,
  });
  const notes: string[] = [];
  if (res.total > res.blueprints.length) {
    notes.push(
      `Scanned the first ${res.blueprints.length} of ${res.total} blueprints.`,
    );
  }
  return {
    findings: deadBlueprintTriggerFindings(res.blueprints, new Date()),
    notes,
  };
}

async function journeysScope(client: AdminClient): Promise<ScopeResult> {
  const [list, metrics] = await Promise.all([
    client.get<JourneyListResponse>("/v1/admin/journeys", {
      limit: LIST_LIMIT,
    }),
    client.get<JourneyMetricsResponse>("/v1/admin/metrics/journeys"),
  ]);

  const findings = deadJourneyTriggerFindings(list.journeys, metrics.journeys);
  const notes: string[] = [];
  if (list.total > list.journeys.length) {
    notes.push(
      `Scanned the first ${list.journeys.length} of ${list.total} journeys.`,
    );
  }

  // Funnel drop-off: fetch per-journey funnels for the highest-enrolled
  // journeys only (bounded — the funnel lives on the {id} route).
  const enrolledById = new Map(
    metrics.journeys.map((m) => [m.journeyId, m.enrolled]),
  );
  const candidates = list.journeys
    .filter((j) => (enrolledById.get(j.id) ?? 0) > 0)
    .sort(
      (a, b) => (enrolledById.get(b.id) ?? 0) - (enrolledById.get(a.id) ?? 0),
    );
  const scanned = candidates.slice(0, MAX_FUNNEL_FETCHES);
  if (candidates.length > scanned.length) {
    notes.push(
      `Funnel analysis covered the top ${scanned.length} of ${candidates.length} enrolled journeys.`,
    );
  }

  // Per-funnel fetches are best-effort: a single journey whose funnel errors
  // (e.g. it was de-registered mid-report) must not sink the whole report.
  const funnelResults = await Promise.all(
    scanned.map(async (j): Promise<FunnelEntry | null> => {
      try {
        const f = await client.get<JourneyFunnelResponse>(
          `/v1/admin/metrics/journeys/${encodeURIComponent(j.id)}`,
        );
        return {
          id: j.id,
          label: `journey "${j.id}"`,
          sent: f.emailSent,
          opened: f.emailOpened,
          clicked: f.emailClicked,
        };
      } catch {
        return null;
      }
    }),
  );
  const funnels = funnelResults.filter((e): e is FunnelEntry => e !== null);
  if (funnels.length < scanned.length) {
    notes.push(
      `Funnel data was unavailable for ${scanned.length - funnels.length} journey(s).`,
    );
  }

  return { findings: [...findings, ...funnelFindings(funnels)], notes };
}

async function deliverabilityScope(client: AdminClient): Promise<ScopeResult> {
  const [deliverability, emails] = await Promise.all([
    client.get<DeliverabilityResponse>(
      "/v1/admin/metrics/emails/deliverability",
    ),
    client.get<EmailMetricsResponse>("/v1/admin/metrics/emails"),
  ]);

  const funnels: FunnelEntry[] = emails.templates.map((t) => ({
    id: t.templateKey,
    label: `template "${t.templateKey}"`,
    sent: t.sent,
    opened: t.opened,
    clicked: t.clicked,
  }));

  return {
    findings: [
      ...deliverabilityFindings(deliverability.points),
      ...funnelFindings(funnels),
    ],
  };
}

async function catalogScope(client: AdminClient) {
  const [templates, events] = await Promise.all([
    client.get<TemplatesResponse>("/v1/admin/templates"),
    client.get<EventNamesResponse>("/v1/admin/events/names"),
  ]);
  return {
    catalog: {
      templates: templates.templates,
      eventNames: events.events,
      eventNamesNote: events.note,
    },
  };
}

type ReportScope = z.output<z.ZodObject<typeof reportShape>>["scope"];

/** The findings-producing scopes (catalog is handled separately). */
const SCOPE_HANDLERS: Record<
  Exclude<ReportScope, "catalog">,
  (client: AdminClient) => Promise<ScopeResult>
> = {
  health: healthScope,
  blueprints: blueprintsScope,
  journeys: journeysScope,
  deliverability: deliverabilityScope,
};

/** Build the `hogsend_report` tool bound to an {@link AdminClient}. */
export function createReportTool(
  client: AdminClient,
): McpTool<typeof reportShape> {
  return defineTool({
    name: NAME,
    description,
    inputSchema: reportShape,
    run: async ({ scope }) => {
      // Identity first — a 401 here means the whole report is unauthorized.
      let identity: unknown;
      try {
        identity = await client.get("/v1/admin/api-keys/self");
      } catch (err) {
        return mapHttpError(err);
      }

      try {
        if (scope === "catalog") {
          const { catalog } = await catalogScope(client);
          return {
            ok: true as const,
            scope,
            generatedFor: identity,
            findings: [] as Finding[],
            catalog,
          };
        }

        const result = await SCOPE_HANDLERS[scope](client);
        return {
          ok: true as const,
          scope,
          generatedFor: identity,
          findings: sortFindings(result.findings),
          ...(result.notes && result.notes.length > 0
            ? { notes: result.notes }
            : {}),
        };
      } catch (err) {
        return mapHttpError(err);
      }
    },
  });
}
