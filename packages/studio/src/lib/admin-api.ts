import { api } from "./api";
import { config } from "./config";

/**
 * Typed wrappers around the engine's /v1/admin/* surface. Types mirror the Zod
 * response schemas in packages/engine/src/routes/admin/*. Kept in one file so
 * views import data shapes + fetchers from a single place.
 */

// --- Overview metrics ----------------------------------------------------

export type OverviewMetrics = {
  totalContacts: number;
  activeJourneys: number;
  emailsSent24h: number;
  emailsSent7d: number;
  emailsSent30d: number;
  bounceRate30d: number;
  unsubscribeRate: number;
};

export function getOverview() {
  return api.get<OverviewMetrics>("/v1/admin/metrics/overview");
}

// --- Dev: open a source file in the local editor -------------------------

/**
 * Ask the engine (dev-only, same machine) to open a source file in whatever
 * editor the developer uses — auto-detected server-side via `launch-editor`.
 * 404s in production; callers gate the UI on `config.isLocalhost`.
 */
export function openFileInEditor(path: string, line?: number) {
  return api.post<{ ok: boolean; target: string }>("/v1/admin/open-in-editor", {
    json: { path, ...(line ? { line } : {}) },
  });
}

// --- Emails (sends) ------------------------------------------------------

export type EmailSend = {
  id: string;
  journeyStateId: string | null;
  templateKey: string | null;
  messageId: string | null;
  /** @deprecated Mirrors `messageId`; the API keeps both for one minor. */
  resendId?: string | null;
  fromEmail: string;
  toEmail: string;
  subject: string;
  category: string | null;
  status: string;
  userId: string | null;
  journeyId: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  bouncedAt: string | null;
  complainedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EmailListResponse = {
  emails: EmailSend[];
  total: number;
  limit: number;
  offset: number;
};

export type EmailListFilters = {
  limit?: number;
  offset?: number;
  toEmail?: string;
  templateKey?: string;
  status?: string;
  journeyId?: string;
  /** Only the sends of one campaign (matched on its per-recipient send keys). */
  campaignId?: string;
  userId?: string;
  category?: string;
  engagement?: string;
  sort?: string;
  order?: string;
  from?: string;
  to?: string;
};

export function listEmails(filters: EmailListFilters) {
  return api.get<EmailListResponse>("/v1/admin/emails", { query: filters });
}

export type EmailEvent = {
  type: string;
  timestamp: string;
  url?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type TrackedLink = {
  id: string;
  originalUrl: string;
  clickCount: number;
  clicks: {
    id: string;
    clickedAt: string;
    ipAddress: string | null;
    userAgent: string | null;
  }[];
};

export type EmailDetail = {
  email: EmailSend;
  events: EmailEvent[];
  trackedLinks: TrackedLink[];
  journeyContext: {
    journeyId: string;
    userId: string;
    status: string;
    currentNodeId: string;
  } | null;
};

export function getEmail(id: string) {
  return api.get<EmailDetail>(`/v1/admin/emails/${id}`);
}

export function resendEmail(id: string) {
  return api.post<{ emailId: string; status: string }>(
    `/v1/admin/emails/${id}/resend`,
  );
}

// --- Templates -----------------------------------------------------------

export type TemplateCatalogEntry = {
  key: string;
  defaultSubject: string;
  category: string | null;
  hasPreview: boolean;
};

export function listTemplates() {
  return api.get<{ templates: TemplateCatalogEntry[] }>("/v1/admin/templates");
}

export type TemplatePreview = {
  key: string;
  subject: string;
  category: string | null;
  preview: string | null;
  html: string;
  text: string;
};

export function getTemplatePreview(key: string) {
  return api.get<TemplatePreview>(
    `/v1/admin/templates/${encodeURIComponent(key)}/preview`,
  );
}

export function sendTestEmail(key: string, to: string) {
  return api.post<{ status: string; emailSendId?: string }>(
    `/v1/admin/templates/${encodeURIComponent(key)}/send-test`,
    { json: { to } },
  );
}

export type TemplateReport = {
  templateKey: string;
  window: { from: string | null; to: string | null };
  totals: {
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    bounced: number;
    complained: number;
    deliveryRate: number;
    openRate: number;
    clickRate: number;
    clickToDeliveryRate: number;
  };
  series: {
    date: string;
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    bounced: number;
  }[];
};

export function getTemplateReport(key: string) {
  return api.get<TemplateReport>(
    `/v1/admin/reporting/templates/${encodeURIComponent(key)}`,
  );
}

// --- Journeys ------------------------------------------------------------

export type JourneyMetric = {
  journeyId: string;
  name: string;
  enrolled: number;
  completed: number;
  failed: number;
  exited: number;
  active: number;
  completionRate: number;
  avgDurationSecs: number | null;
};

export function listJourneyMetrics() {
  return api.get<{ journeys: JourneyMetric[] }>("/v1/admin/metrics/journeys");
}

export type JourneyFunnel = {
  journeyId: string;
  enrolled: number;
  emailSent: number;
  emailOpened: number;
  emailClicked: number;
  completed: number;
  failed: number;
  exited: number;
};

export function getJourneyFunnel(id: string) {
  return api.get<JourneyFunnel>(
    `/v1/admin/metrics/journeys/${encodeURIComponent(id)}`,
  );
}

export type JourneyListItem = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: { event: string };
  entryLimit: "once" | "once_per_period" | "unlimited";
  /** Conversion definition id the lift/impact readouts default to. */
  goal?: string;
  counts: {
    active: number;
    waiting: number;
    completed: number;
    failed: number;
    exited: number;
    held_out?: number;
  };
};

export function listJourneys() {
  return api.get<{
    journeys: JourneyListItem[];
    total: number;
    limit: number;
    offset: number;
  }>("/v1/admin/journeys", { query: { limit: 100 } });
}

export function setJourneyEnabled(id: string, enabled: boolean) {
  return api.put<{
    journey: { id: string; name: string; enabled: boolean; updatedAt: string };
  }>(`/v1/admin/journeys/${encodeURIComponent(id)}`, { json: { enabled } });
}

export type JourneyStateStatus =
  | "active"
  | "waiting"
  | "completed"
  | "failed"
  | "exited"
  | "held_out";

/** One enrolled instance of a journey (a row of `journey_states`). */
export type JourneyState = {
  id: string;
  userId: string;
  userEmail: string;
  journeyId: string;
  currentNodeId: string;
  status: string;
  hatchetRunId: string | null;
  context: Record<string, unknown>;
  errorMessage: string | null;
  entryCount: number;
  completedAt: string | null;
  exitedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** A single condition object (PropertyCondition et al.) — shape-opaque here. */
export type JourneyCondition = Record<string, unknown>;

export type JourneyDetail = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: { event: string; where?: JourneyCondition[] };
  exitOn?: Array<{ event: string; where?: JourneyCondition[] }>;
  entryLimit: "once" | "once_per_period" | "unlimited";
  /** Conversion definition id the lift/impact readouts default to. */
  goal?: string;
  suppress: Record<string, number>;
  counts: {
    active: number;
    waiting: number;
    completed: number;
    failed: number;
    exited: number;
    held_out?: number;
  };
  recentStates: JourneyState[];
};

export function getJourney(id: string) {
  return api.get<{ journey: JourneyDetail }>(
    `/v1/admin/journeys/${encodeURIComponent(id)}`,
  );
}

export type JourneyStatesFilter = {
  status?: JourneyStateStatus;
  limit?: number;
  offset?: number;
  userId?: string;
};

export function listJourneyStates(
  id: string,
  filter: JourneyStatesFilter = {},
) {
  return api.get<{
    states: JourneyState[];
    total: number;
    limit: number;
    offset: number;
  }>(`/v1/admin/journeys/${encodeURIComponent(id)}/states`, {
    query: {
      status: filter.status,
      limit: filter.limit,
      offset: filter.offset,
      userId: filter.userId,
    },
  });
}

/** One transition row from `journey_logs` (node → node, with a detail bag). */
export type JourneyLog = {
  id: string;
  fromNodeId: string | null;
  toNodeId: string | null;
  action: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
};

export function getJourneyState(id: string, stateId: string) {
  return api.get<{ state: JourneyState; logs: JourneyLog[] }>(
    `/v1/admin/journeys/${encodeURIComponent(id)}/states/${encodeURIComponent(
      stateId,
    )}`,
  );
}

/** A template the journey has SENT, with engagement counts (observed). */
export type JourneyTemplate = {
  templateKey: string;
  sent: number;
  opened: number;
  clicked: number;
  lastSentAt: string | null;
};

export function getJourneyTemplates(id: string) {
  return api.get<{ templates: JourneyTemplate[] }>(
    `/v1/admin/journeys/${encodeURIComponent(id)}/templates`,
  );
}

// --- Journey graph (visual workflow) -------------------------------------

/**
 * The journey graph IR — mirrors `@hogsend/core` `JourneyNode`/`JourneyEdge`/
 * `JourneyGraph`. Kept as a local type (not a workspace import) because the
 * Studio ships as a standalone SPA `dist` and does not bundle engine source.
 */
export type JourneyGraphNodeType =
  | "start"
  | "sleep"
  | "sleepUntil"
  | "wait"
  | "digest"
  | "send"
  | "connector"
  | "checkpoint"
  | "trigger"
  | "capture"
  | "branch"
  | "decision"
  | "end-completed"
  | "end-exited"
  | "end-failed"
  | "unknown";

type JourneyGraphNodeBase = {
  id: string;
  title: string;
  subtitle?: string;
  line?: number;
};

/** `unstable` is a property of the node id, shared by every variant's meta. */
type JourneyGraphNodeMetaBase = { unstable?: boolean };

/**
 * Discriminated union on `type` — one variant per node type, each carrying
 * only the meta fields that node type actually uses (mirrors the core union).
 * `conditions` stays display-loose (`unknown[]`): the Studio only renders it
 * as JSON, and mirroring core's full `ConditionEval` here would defeat the
 * no-workspace-import rule above.
 */
export type JourneyGraphNode =
  | (JourneyGraphNodeBase & {
      type: "start";
      meta?: JourneyGraphNodeMetaBase & { conditions?: unknown[] };
    })
  | (JourneyGraphNodeBase & {
      type: "sleep";
      meta?: JourneyGraphNodeMetaBase & { duration?: Record<string, number> };
    })
  | (JourneyGraphNodeBase & {
      type: "sleepUntil";
      meta?: JourneyGraphNodeMetaBase;
    })
  | (JourneyGraphNodeBase & {
      type: "wait";
      meta?: JourneyGraphNodeMetaBase & {
        event?: string;
        timeout?: Record<string, number>;
      };
    })
  | (JourneyGraphNodeBase & {
      type: "digest";
      meta?: JourneyGraphNodeMetaBase & {
        event?: string;
        duration?: Record<string, number>;
      };
    })
  | (JourneyGraphNodeBase & {
      type: "send";
      meta?: JourneyGraphNodeMetaBase & {
        template?: string;
        idempotencyLabel?: string;
      };
    })
  | (JourneyGraphNodeBase & {
      type: "connector";
      meta?: JourneyGraphNodeMetaBase & {
        connectorId?: string;
        action?: string;
      };
    })
  | (JourneyGraphNodeBase & {
      type: "checkpoint";
      meta?: JourneyGraphNodeMetaBase;
    })
  | (JourneyGraphNodeBase & {
      type: "trigger";
      meta?: JourneyGraphNodeMetaBase & { event?: string };
    })
  | (JourneyGraphNodeBase & {
      type: "capture";
      meta?: JourneyGraphNodeMetaBase;
    })
  | (JourneyGraphNodeBase & {
      type: "branch" | "decision";
      meta?: JourneyGraphNodeMetaBase & { conditions?: unknown[] };
    })
  | (JourneyGraphNodeBase & {
      type: "end-completed" | "end-exited" | "end-failed";
      meta?: JourneyGraphNodeMetaBase;
    })
  | (JourneyGraphNodeBase & {
      type: "unknown";
      meta?: JourneyGraphNodeMetaBase & { [key: string]: unknown };
    });

export type JourneyGraphEdgeKind =
  | "default"
  | "timedOut"
  | "answered"
  | "conditional-true"
  | "conditional-false";

export type JourneyGraphEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  kind?: JourneyGraphEdgeKind;
};

export type JourneyGraph = {
  journeyId: string;
  /** Where `defineJourney` was called — for the "open in editor" link. */
  source?: { path: string; line: number };
  nodes: JourneyGraphNode[];
  edges: JourneyGraphEdge[];
  degraded?: boolean;
  warnings?: string[];
};

/**
 * Retroactive per-node metric: people here now + failures at this node, plus
 * the resolved email template key for `send` nodes (server-resolved from
 * journey_logs / observed email_sends) so the side panel can preview it.
 */
export type JourneyNodeMetric = {
  live: number;
  failed: number;
  templateKey?: string;
  /** Source path of the send node's template component — for "open in editor". */
  templatePath?: string;
};

export type JourneyGraphResponse = {
  graph: JourneyGraph;
  metrics: {
    enrolled: number;
    terminals: { completed: number; failed: number; exited: number };
    nodes: Record<string, JourneyNodeMetric>;
  };
};

export function getJourneyGraph(id: string) {
  return api.get<JourneyGraphResponse>(
    `/v1/admin/journeys/${encodeURIComponent(id)}/graph`,
  );
}

// --- Journey Blueprints (JSON-authored journeys, no PR required) ---------

/**
 * MCP/API-authored journeys stored as data (`journey_blueprints`), executed
 * by the same worker + `JourneyGraph` primitives as a code journey — view +
 * enable/disable only here; authoring stays MCP-only for now.
 */
export type BlueprintStatus = "draft" | "enabled" | "disabled";
export type BlueprintSource = "mcp" | "studio" | "api";

/** One shared status→badge mapping, consumed by the list and detail views. */
export const BLUEPRINT_STATUS_LABEL: Record<BlueprintStatus, string> = {
  enabled: "Enabled",
  disabled: "Disabled",
  draft: "Draft",
};
export const BLUEPRINT_STATUS_VARIANT: Record<
  BlueprintStatus,
  "default" | "secondary" | "outline"
> = {
  enabled: "default",
  disabled: "secondary",
  draft: "outline",
};

export type BlueprintCounts = {
  active: number;
  waiting: number;
  completed: number;
  failed: number;
  exited: number;
};

type BlueprintBase = {
  id: string;
  name: string;
  description: string | null;
  status: BlueprintStatus;
  version: number;
  triggerEvent: string;
  triggerWhere: JourneyCondition[] | null;
  entryLimit: "once" | "once_per_period" | "unlimited";
  entryPeriod: Record<string, number> | null;
  exitOn: Array<{ event: string; where?: JourneyCondition[] }> | null;
  suppress: Record<string, number>;
  source: BlueprintSource;
  createdBy: string | null;
  promotedAt: string | null;
  promotedToJourneyId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BlueprintListItem = BlueprintBase & { counts: BlueprintCounts };

// `graph` is intentionally NOT declared here even though the engine's
// response includes it: no Studio view reads it off the detail payload — the
// flow canvas always fetches it (+ metrics) via `getBlueprintGraph` instead.
// Keeping it off the type avoids a second, unused copy of the full graph
// tempting a future caller into reading stale/metric-less data.
export type BlueprintDetail = BlueprintBase & {
  counts: BlueprintCounts;
  recentStates: JourneyState[];
};

/** `paginationQuerySchema.max(100)` is the route's hard per-page ceiling. */
const BLUEPRINT_PAGE_SIZE = 100;
/** Stop after this many pages so a runaway total can't hammer the API. */
const BLUEPRINT_MAX_PAGES = 10;

export type BlueprintListResult = {
  blueprints: BlueprintListItem[];
  /** Server-reported grand total (may exceed `blueprints.length` if capped). */
  total: number;
  /** True when the hard page cap was hit before `total` was fully fetched. */
  truncated: boolean;
};

/**
 * Page through `GET /v1/admin/blueprints` (per-page max 100) up to a hard cap
 * so blueprint 101+ isn't silently dropped. `truncated` lets the caller flag
 * that more rows exist than were fetched instead of showing a short list.
 */
export async function listBlueprints(): Promise<BlueprintListResult> {
  const blueprints: BlueprintListItem[] = [];
  let total = 0;
  for (let page = 0; page < BLUEPRINT_MAX_PAGES; page++) {
    const res = await api.get<{
      blueprints: BlueprintListItem[];
      total: number;
      limit: number;
      offset: number;
    }>("/v1/admin/blueprints", {
      query: {
        limit: BLUEPRINT_PAGE_SIZE,
        offset: page * BLUEPRINT_PAGE_SIZE,
      },
    });
    total = res.total;
    blueprints.push(...res.blueprints);
    if (res.blueprints.length < BLUEPRINT_PAGE_SIZE) break;
    if (blueprints.length >= total) break;
  }
  return { blueprints, total, truncated: blueprints.length < total };
}

export function getBlueprint(id: string) {
  return api.get<{ blueprint: BlueprintDetail }>(
    `/v1/admin/blueprints/${encodeURIComponent(id)}`,
  );
}

/** Byte-identical response shape to `getJourneyGraph` — same renderer. */
export function getBlueprintGraph(id: string) {
  return api.get<JourneyGraphResponse>(
    `/v1/admin/blueprints/${encodeURIComponent(id)}/graph`,
  );
}

// What /enable and /disable actually return (`serializeBlueprint(row)`,
// engine's routes/admin/blueprints.ts) — no `counts`/`recentStates` (unlike
// `BlueprintDetail`, only GET /:id adds those), but it DOES include `graph`.
type SerializedBlueprint = BlueprintBase & { graph: JourneyGraph };

export function enableBlueprint(id: string) {
  return api.post<{ blueprint: SerializedBlueprint }>(
    `/v1/admin/blueprints/${encodeURIComponent(id)}/enable`,
  );
}

export function disableBlueprint(id: string) {
  return api.post<{ blueprint: SerializedBlueprint }>(
    `/v1/admin/blueprints/${encodeURIComponent(id)}/disable`,
  );
}

// --- Buckets -------------------------------------------------------------

export type BucketListItem = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  kind: "dynamic" | "manual";
  timeBased: boolean;
  entryLimit: "once" | "once_per_period" | "unlimited";
  counts: {
    active: number;
    left: number;
  };
};

export function listBuckets() {
  return api.get<{
    buckets: BucketListItem[];
    total: number;
    limit: number;
    offset: number;
  }>("/v1/admin/buckets", { query: { limit: 100 } });
}

export type BucketMember = {
  id: string;
  userId: string;
  userEmail: string | null;
  bucketId: string;
  status: string;
  enteredAt: string;
  leftAt: string | null;
  expiresAt: string | null;
  lastEvaluatedAt: string | null;
  entryCount: number;
  source: string | null;
  context: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type BucketFeedJourney = {
  id: string;
  name: string;
  trigger: string;
  sourceBucketId: string | null;
  owned: boolean;
};

export type BucketDetail = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  kind: "dynamic" | "manual";
  timeBased: boolean;
  entryLimit: "once" | "once_per_period" | "unlimited";
  criteria?: Record<string, unknown>;
  entryPeriod?: Record<string, unknown> | null;
  minDwell?: Record<string, unknown> | null;
  maxDwell?: Record<string, unknown> | null;
  reconcileEvery?: Record<string, unknown> | null;
  fastExpiry: boolean;
  syncToPostHog: boolean;
  counts: {
    active: number;
    left: number;
  };
  feedsJourneys: BucketFeedJourney[];
  recentMembers: BucketMember[];
};

export function getBucket(id: string) {
  return api.get<{ bucket: BucketDetail }>(
    `/v1/admin/buckets/${encodeURIComponent(id)}`,
  );
}

export function listBucketMembers(
  id: string,
  query?: { limit?: number; offset?: number; status?: "active" | "left" },
) {
  return api.get<{
    members: BucketMember[];
    total: number;
    limit: number;
    offset: number;
  }>(`/v1/admin/buckets/${encodeURIComponent(id)}/members`, { query });
}

export type BucketMetric = {
  bucketId: string;
  name: string;
  size: number;
  entered: number;
  left: number;
  avgDwellSecs: number | null;
};

export function listBucketMetrics() {
  return api.get<{ buckets: BucketMetric[] }>("/v1/admin/metrics/buckets");
}

export type BucketTrend = {
  bucketId: string;
  size: number;
  points: {
    date: string;
    entered: number;
    left: number;
  }[];
};

export function getBucketTrend(id: string, period?: "day" | "week" | "month") {
  return api.get<BucketTrend>(
    `/v1/admin/metrics/buckets/${encodeURIComponent(id)}`,
    { query: { period } },
  );
}

export function setBucketEnabled(id: string, enabled: boolean) {
  return api.patch<{
    bucket: { id: string; name: string; enabled: boolean; updatedAt: string };
  }>(`/v1/admin/buckets/${encodeURIComponent(id)}`, { json: { enabled } });
}

// --- Groups --------------------------------------------------------------

/**
 * One currency's worth of a group's money. The revenue spine's law: totals are
 * grouped PER CURRENCY and never summed across them (a GBP deal and a USD deal
 * don't add), so the UI renders them side by side — it must never add them up.
 * `currency` is null for a valued event ingested without one.
 */
export type GroupRevenueTotal = {
  currency: string | null;
  total: number;
};

/**
 * The base-currency FX lens block — non-null on a list/detail response exactly
 * when the lens served rates, so converted figures can be labelled honestly
 * ("≈ in USD, rates as of <date>"). `asOf` is null when the rate sheet carries
 * no date.
 */
export type GroupFx = {
  baseCurrency: string;
  asOf: string | null;
};

/**
 * One row of `GET /v1/admin/groups` — an account/team/company-level record
 * tracked from events + memberships. Mirrors the engine group schema
 * (routes/admin/groups.ts). `properties` is an opaque bag; `memberCount` is a
 * server-computed rollup over live memberships. Observe-only: groups are
 * authored in the data plane, never from Studio.
 *
 * Money arrives twice: `revenueTotals` (per currency, the truth) and
 * `revenueBase` (the same money converted into the operator's base currency —
 * the opt-in lens). `revenueBase` is null when the lens is off OR when any of
 * this group's currencies lacks a rate, because a partial sum would lie.
 */
export type AdminGroup = {
  id: string;
  groupType: string;
  groupKey: string;
  displayName: string | null;
  properties: Record<string, unknown>;
  memberCount: number;
  revenueTotals: GroupRevenueTotal[];
  revenueBase: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

/** One member of a group (a `group_memberships` row joined to its contact). */
export type AdminGroupMember = {
  contactId: string;
  email: string | null;
  externalId: string | null;
  role: string | null;
  joinedAt: string;
};

/** One event tagged with a group (a `user_events` row), newest first. */
export type AdminGroupEvent = {
  id: string;
  event: string;
  occurredAt: string;
  userId: string;
};

/** `GET /:groupType/:groupKey` — the group plus its recent members + events. */
export type AdminGroupDetail = AdminGroup & {
  recentMembers: AdminGroupMember[];
  recentEvents: AdminGroupEvent[];
};

/**
 * Server-side sort keys. `revenue` ranks on a cross-currency scalar — an
 * ordering heuristic the server never displays (exact for a single-currency
 * deployment, approximate for a mixed one; base-converted when the FX lens
 * covers every currency in play).
 */
export type GroupSort = "lastSeen" | "members" | "revenue" | "name";

export type GroupListFilters = {
  limit?: number;
  offset?: number;
  groupType?: string;
  /** Case-insensitive substring over the group key or display name. */
  search?: string;
  sort?: GroupSort;
  order?: "asc" | "desc";
};

export function listGroups(filters: GroupListFilters = {}) {
  return api.get<{
    groups: AdminGroup[];
    total: number;
    limit: number;
    offset: number;
    fx: GroupFx | null;
  }>("/v1/admin/groups", {
    query: {
      limit: filters.limit,
      offset: filters.offset,
      groupType: filters.groupType || undefined,
      search: filters.search || undefined,
      sort: filters.sort,
      order: filters.order,
    },
  });
}

export function getGroup(groupType: string, groupKey: string) {
  return api.get<{ group: AdminGroupDetail; fx: GroupFx | null }>(
    `/v1/admin/groups/${encodeURIComponent(groupType)}/${encodeURIComponent(
      groupKey,
    )}`,
  );
}

export function listGroupMembers(
  groupType: string,
  groupKey: string,
  query?: { limit?: number; offset?: number },
) {
  return api.get<{
    members: AdminGroupMember[];
    total: number;
    limit: number;
    offset: number;
  }>(
    `/v1/admin/groups/${encodeURIComponent(groupType)}/${encodeURIComponent(
      groupKey,
    )}/members`,
    { query },
  );
}

// --- Contacts ------------------------------------------------------------

export type Contact = {
  id: string;
  externalId: string;
  email: string | null;
  properties: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

export type ContactPreferences = {
  id: string;
  userId: string;
  email: string;
  unsubscribedAll: boolean;
  suppressed: boolean;
  bounceCount: number;
  categories: Record<string, boolean>;
} | null;

export type ContactListFilters = {
  search?: string;
  /** Long-tail value filter: sum of the contact's valued events ≥ this. */
  minRevenue?: number;
  /** Has a deal currently in this canonical stage. */
  dealStage?: string;
};

export function listContacts(filters: ContactListFilters = {}) {
  return api.get<{
    contacts: Contact[];
    total: number;
    limit: number;
    offset: number;
  }>("/v1/admin/contacts", {
    query: {
      search: filters.search || undefined,
      minRevenue: filters.minRevenue,
      dealStage: filters.dealStage || undefined,
      limit: 50,
    },
  });
}

/** Per-currency revenue rollup over the contact's valued events. */
export type ContactRevenue = {
  totals: { currency: string | null; total: number; count: number }[];
  lastValuedAt: string | null;
};

/** One group a contact belongs to — a `group_memberships` row joined to its
 * live group, linking to that group's Studio page. */
export type ContactGroup = {
  groupType: string;
  groupKey: string;
  displayName: string | null;
  role: string | null;
  joinedAt: string;
};

export function getContact(id: string) {
  return api.get<{
    contact: Contact;
    preferences: ContactPreferences;
    revenue: ContactRevenue;
    groups: ContactGroup[];
  }>(`/v1/admin/contacts/${encodeURIComponent(id)}`);
}

export type ContactActivity = {
  contact: { externalId: string; email: string | null };
  sends: {
    id: string;
    templateKey: string | null;
    subject: string;
    status: string;
    sentAt: string | null;
    deliveredAt: string | null;
    openedAt: string | null;
    clickedAt: string | null;
    bouncedAt: string | null;
    complainedAt: string | null;
    bounceType: string | null;
    createdAt: string;
  }[];
  total: number;
  limit: number;
  offset: number;
};

export function getContactActivity(id: string) {
  return api.get<ContactActivity>(
    `/v1/admin/reporting/contacts/${encodeURIComponent(id)}/activity`,
  );
}

export type TimelineEntry = {
  type: "event" | "journey" | "email";
  timestamp: string;
  data: Record<string, unknown>;
};

export function getContactTimeline(id: string) {
  return api.get<{
    timeline: TimelineEntry[];
    total: number;
    limit: number;
    offset: number;
  }>(`/v1/admin/contacts/${encodeURIComponent(id)}/timeline`, {
    query: { limit: 100 },
  });
}

export function updateContactPreferences(
  id: string,
  body: {
    suppressed?: boolean;
    unsubscribedAll?: boolean;
    categories?: Record<string, boolean>;
  },
) {
  return api.put<{ preferences: NonNullable<ContactPreferences> }>(
    `/v1/admin/contacts/${encodeURIComponent(id)}/preferences`,
    { json: body },
  );
}

// --- Lists (defined subscription lists) ----------------------------------

/**
 * One registered list from `GET /v1/admin/lists` — an author-defined topic OR
 * an engine-synthesized delivery channel. Mirrors the engine list schema
 * (routes/admin/lists.ts). `defaultOptIn` is the resolution polarity: a
 * contact's subscription is `prefs.categories[id] ?? defaultOptIn`.
 */
export type DefinedListMeta = {
  id: string;
  name: string;
  description?: string;
  defaultOptIn: boolean;
  enabled: boolean;
  kind: "channel" | "topic";
};

export function listDefinedLists() {
  return api.get<{ lists: DefinedListMeta[] }>("/v1/admin/lists");
}

// --- Suppressions --------------------------------------------------------

export type Suppression = {
  id: string;
  userId: string;
  email: string;
  unsubscribedAll: boolean;
  suppressed: boolean;
  bounceCount: number;
  categories: Record<string, boolean>;
  suppressedAt: string | null;
  lastBounceAt: string | null;
};

export function listSuppressions(type: string | undefined) {
  return api.get<{
    suppressions: Suppression[];
    total: number;
    limit: number;
    offset: number;
  }>("/v1/admin/suppressions", { query: { type, limit: 200 } });
}

// --- API keys ------------------------------------------------------------

export type ApiKey = {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdBy: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
};

export function listApiKeys() {
  return api.get<{
    keys: ApiKey[];
    total: number;
    limit: number;
    offset: number;
  }>("/v1/admin/api-keys", { query: { limit: 100, includeRevoked: "true" } });
}

export type CreatedApiKey = {
  id: string;
  name: string;
  key: string;
  keyPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  createdAt: string;
};

export function createApiKey(body: {
  name: string;
  scopes: ("read" | "journey-admin" | "full-admin")[];
}) {
  return api.post<CreatedApiKey>("/v1/admin/api-keys", { json: body });
}

export function revokeApiKey(id: string) {
  return api.delete<{ revoked: boolean }>(
    `/v1/admin/api-keys/${encodeURIComponent(id)}`,
  );
}

// --- Operator settings — Currency (FX lens) --------------------------------

/**
 * `GET/PUT/DELETE /v1/admin/settings/fx` — the base-currency choice behind the
 * groups FX lens. The precedence the card renders: a setting ROW wins over env
 * (`baseCurrency: null` in the row = the operator EXPLICITLY turned the lens
 * off, beating env `BASE_CURRENCY`); NO row = env decides, else off. Every
 * mutation returns this same full state, so one shape serves all three verbs.
 */
export type FxSettingState = {
  /** The stored operator choice, or null when no row exists. */
  setting: { baseCurrency: string | null } | null;
  /** The env bootstrap default (`BASE_CURRENCY`). */
  env: { baseCurrency: string | null };
  /** What the lens actually resolves right now (null = off). */
  effective: { baseCurrency: string | null };
  /**
   * The rate source probed against the effective base — null when none is
   * configured at all. `servesEffectiveBase: false` with a base set means
   * converted figures will NOT appear (e.g. a USD-quoted static sheet asked
   * for EUR — the honesty rule).
   */
  provider: {
    id: string;
    asOf: string | null;
    servesEffectiveBase: boolean;
  } | null;
};

export function getFxSetting() {
  return api.get<FxSettingState>("/v1/admin/settings/fx");
}

/** `baseCurrency: null` = explicitly turn the lens OFF (beats env). */
export function putFxSetting(baseCurrency: string | null) {
  return api.put<FxSettingState>("/v1/admin/settings/fx", {
    json: { baseCurrency },
  });
}

/** Remove the override entirely — fall back to env `BASE_CURRENCY`. */
export function deleteFxSetting() {
  return api.delete<FxSettingState>("/v1/admin/settings/fx");
}

// --- Events (test events) ------------------------------------------------

export type IngestExit = {
  journeyId: string;
  stateId: string;
  exited: boolean;
};

export type IngestResult = {
  stored: boolean;
  exits: IngestExit[];
};

/**
 * Fire an event through the ingest pipeline — the same path real events take —
 * via the session-authed admin endpoint (POST /v1/admin/events). Powers the
 * Debug panel's test-event sender.
 *
 * Studio authenticates with Better Auth session cookies, not an hsk_ API key,
 * so it cannot use the public data-plane `/v1/events` route (which sits behind
 * requireApiKey + requireScope("ingest")). Letting session cookies through that
 * public guard would be a CSRF risk; instead the admin router exposes this
 * session-authed ingest. Per the D2 property split, the Debug panel only sends
 * `eventProperties` (here `properties`) — contact-property writes are not
 * exposed.
 */
export function ingestEvent(body: {
  event: string;
  userId: string;
  userEmail?: string;
  properties?: Record<string, unknown>;
}) {
  return api.post<IngestResult>("/v1/admin/events", {
    json: {
      event: body.event,
      userId: body.userId,
      userEmail: body.userEmail,
      properties: body.properties ?? {},
    },
  });
}

// --- Events feed ---------------------------------------------------------

/** One ingested event (a `user_events` row joined to its live contact). */
export type EventListItem = {
  id: string;
  userId: string;
  event: string;
  properties: Record<string, unknown> | null;
  occurredAt: string;
  /** Where the event entered the pipeline ("posthog", "api", "studio", …). */
  source: string | null;
  /** The person this event is from (matched live contact), or null. */
  userEmail: string | null;
  /** The matched contact's id (uuid) — pass to getContact / ContactDetailDrawer. */
  contactId: string | null;
};

export type EventListFilters = {
  limit?: number;
  offset?: number;
  userId?: string;
  event?: string;
  source?: string;
  from?: string;
  to?: string;
};

export function listEvents(filters: EventListFilters) {
  return api.get<{
    events: EventListItem[];
    total: number;
    limit: number;
    offset: number;
  }>("/v1/admin/events", { query: filters });
}

export function getEvent(id: string) {
  return api.get<{ event: EventListItem }>(
    `/v1/admin/events/${encodeURIComponent(id)}`,
  );
}

// --- Domain (Setup) --------------------------------------------------------

/** Mirrors the pinned `DnsRecord` shape (@hogsend/core providers/domains.ts). */
export type DnsRecord = {
  type: "TXT" | "CNAME" | "MX";
  name: string;
  value: string;
  ttl?: number;
  priority?: number;
  purpose:
    | "verification"
    | "spf"
    | "dkim"
    | "return_path"
    | "tracking"
    | "mx"
    | "other";
  status: "pending" | "verified" | "failed" | "unknown";
};

export type DomainVerificationState =
  | "not_found"
  | "pending"
  | "verified"
  | "failed";

/** Mirrors the pinned `DomainStatus` shape. */
export type DomainStatus = {
  domain: string;
  state: DomainVerificationState;
  records: DnsRecord[];
  providerId: string;
  checkedAt: string;
  raw?: unknown;
};

/** Mirrors the pinned `TestModeState` shape (stubbed inactive until F3). */
export type TestModeState = {
  active: boolean;
  reason: "env_flag" | "domain_unverified" | null;
  redirectTo: string | null;
  fromOverride: string | null;
};

/** Mirrors the pinned `EngineDomainStatus` shape. */
export type EngineDomainStatus = {
  domain: string | null;
  providerId: string;
  supported: boolean;
  status: DomainStatus | null;
  testMode: TestModeState;
};

export function getDomainStatus(refresh?: boolean) {
  return api.get<EngineDomainStatus>("/v1/admin/domain", {
    query: { refresh: refresh ? "true" : undefined },
  });
}

export function addDomain(domain: string) {
  return api.post<EngineDomainStatus>("/v1/admin/domain", {
    json: { domain },
  });
}

export function verifyDomain() {
  return api.post<EngineDomainStatus>("/v1/admin/domain/verify");
}

// --- Setup readiness (non-blocking FTUX checklist) ------------------------

/**
 * One row of the setup checklist from `GET /v1/admin/readiness`.
 * `ok` = done · `action` = needs doing · `optional` = nice-to-have, not done.
 */
export type ReadinessCheck = {
  id: string;
  label: string;
  status: "ok" | "action" | "optional";
  detail: string;
  docsUrl?: string;
};

export type Readiness = {
  /** true when nothing is left in the `action` state (optional rows may remain). */
  ready: boolean;
  doneCount: number;
  totalCount: number;
  checks: ReadinessCheck[];
};

export function getReadiness() {
  return api.get<Readiness>("/v1/admin/readiness");
}

// --- Integrations (connectors + destinations) ----------------------------

/**
 * One integration row from `GET /v1/admin/connectors` — a code-registered
 * inbound connector and/or outbound destination, joined to its stored-
 * credential meta. Mirrors the engine's `integrationSchema`. Token material is
 * never present (observe-and-connect only).
 */
export type IntegrationTransport = "webhook" | "gateway" | "poll";

export type IntegrationCredential = {
  connected: boolean;
  kind?: "oauth" | "derived";
  updatedAt?: string;
} | null;

export type Integration = {
  id: string;
  name: string;
  transport: IntegrationTransport;
  hasConnector: boolean;
  hasDestination: boolean;
  description?: string;
  credential: IntegrationCredential;
  webhook?: {
    url: string;
    secretConfigured: boolean;
  };
  gateway?: {
    /** Tri-state: true = installed, false = not installed, null = unknown. */
    botInstalled: boolean | null;
    guildId: string | null;
    intents: number | null;
    workerHealthy: boolean;
    workerLastSeenAt: string | null;
    linkedMembers: number;
    unlinkedMembers: number;
  };
};

export function listIntegrations() {
  return api.get<{ integrations: Integration[] }>("/v1/admin/connectors");
}

/** Discord connect signal — drives the invite-bot button + readiness chips. */
export type DiscordConnectInfo = {
  providerId: "discord";
  apiPublicUrl: string;
  redirectUri: string;
  interactionsUrl: string;
  credentialStored: boolean;
  guildId: string | null;
  /** Tri-state: true = installed, false = not installed, null = unknown. */
  botInstalled: boolean | null;
  /** True when a fresh gateway-worker heartbeat is present (Worker Online). */
  workerOnline: boolean;
  workerLastSeenAt: string | null;
  apiPublicUrlReachable: boolean;
  /** Server-built one-click invite URL; `null` until secrets are pasted via CLI. */
  installUrl: string | null;
};

export function getDiscordConnectInfo() {
  return api.get<DiscordConnectInfo>(
    "/v1/admin/connectors/discord/connect-info",
  );
}

/**
 * Disconnect an integration — purges BOTH stored credential kinds (oauth grant
 * + derived config) via the existing provider-credentials DELETE route. Studio
 * never stores secrets, so this is the only mutation the page performs.
 */
export function disconnectIntegration(providerId: string) {
  return api.delete<{ deleted: boolean }>(
    `/v1/admin/provider-credentials/${encodeURIComponent(providerId)}`,
  );
}

// --- Links (generic first-party link tracker) ----------------------------

/**
 * One row from `GET /v1/admin/links` — a first-party tracked link minted
 * outside the email pipeline (mintLink). `type` enforces the share-safe
 * invariant: a `distinctId` is only ever attached to `personal` links
 * (single-recipient, do-not-share); `public` links carry no identity.
 * One FLAT shape everywhere: `url` is the short redirect URL and `clickCount`
 * the computed count. Mirrors the engine link schema (routes/admin/links.ts).
 */
export type Link = {
  id: string;
  /** The link's redirect tracked-row id (one per managed link). */
  trackedLinkId: string | null;
  originalUrl: string;
  type: "personal" | "public";
  /** Vanity slug (normalized lowercase, unique per instance) — null if unset. */
  slug: string | null;
  /** The vanity short URL (`${API_PUBLIC_URL}/l/:slug`) — null if no slug. */
  vanityUrl: string | null;
  label: string | null;
  /** Longer operator note for bulk identification ("sticker on the door"). */
  description: string | null;
  /** Arrival attribution opt-in: redirects append `hs_ref=<click id>`. */
  appendRef: boolean;
  campaign: string | null;
  source: string | null;
  distinctId: string | null;
  createdBy: string | null;
  /** Total across ALL entry paths — vanity, UUID, and QR scans. */
  clickCount: number;
  /** QR-only subtotal (clicks recorded on the link's scan row). */
  scanCount: number;
  /** The short redirect URL: `${API_PUBLIC_URL}/v1/t/c/:trackedLinkId`. */
  url: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

/** One click recorded against a link (link_clicks row), newest first. */
export type LinkClick = {
  id: string;
  trackedLinkId: string;
  clickedAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  /**
   * Arrival stamp: who landed from this hit. `visitorKind` is the trust
   * tier — 'token' = verified userId (known contact), 'anon' = raw anon id.
   */
  visitorDistinctId: string | null;
  visitorKind: string | null;
  arrivedAt: string | null;
};

/**
 * Per-destination stats bucket: hits grouped by the destination that was live
 * when they landed. `url: null` = hits from before provenance stamping.
 * Ordered newest-activity-first (the current destination leads).
 */
export type DestinationStat = {
  url: string | null;
  clicks: number;
  scans: number;
  firstAt: string;
  lastAt: string;
};

/** `GET /:id` — the flat link plus its recent clicks + destination buckets. */
export type LinkDetail = Link & {
  clicks: LinkClick[];
  destinations: DestinationStat[];
  /** Landing-confirmed arrivals; `identifiedArrivalCount` = known contacts. */
  arrivalCount: number;
  identifiedArrivalCount: number;
};

/**
 * Created link — the create route mints a `links` row + a `tracked_links` row
 * and returns the flat link (its short redirect URL is `link.url`).
 */
export type CreatedLink = Link;

export function listLinks(filters?: {
  type?: "personal" | "public";
  includeArchived?: boolean;
  /** true = only links whose QR scan row exists (the "QR codes" lens). */
  hasQr?: boolean;
}) {
  return api.get<{
    links: Link[];
    total: number;
    limit: number;
    offset: number;
  }>("/v1/admin/links", {
    query: {
      type: filters?.type,
      includeArchived: filters?.includeArchived ? "true" : undefined,
      hasQr: filters?.hasQr ? "true" : undefined,
      limit: 200,
    },
  });
}

export function getLink(id: string) {
  return api.get<LinkDetail>(`/v1/admin/links/${encodeURIComponent(id)}`);
}

export function createLink(body: {
  url: string;
  label: string;
  type: "personal" | "public";
  campaign?: string;
  description?: string;
  /** Arrival attribution opt-in (`hs_ref` on redirects). */
  appendRef?: boolean;
  /** Optional vanity slug (`/l/:slug`). 409 if already taken. */
  slug?: string;
  /** Honored only when `type === "personal"` (share-safe invariant). */
  distinctId?: string;
}) {
  return api.post<CreatedLink>("/v1/admin/links", { json: body });
}

export function updateLink(
  id: string,
  body: {
    label?: string;
    description?: string | null;
    appendRef?: boolean;
    campaign?: string;
    originalUrl?: string;
    /** string = set/replace (409 if taken); null = clear the slug. */
    slug?: string | null;
  },
) {
  return api.patch<Link>(`/v1/admin/links/${encodeURIComponent(id)}`, {
    json: body,
  });
}

/** Archive (soft-delete) a link — sets `archivedAt`; the short URL keeps working. */
export function archiveLink(id: string) {
  return api.delete<Link>(`/v1/admin/links/${encodeURIComponent(id)}`);
}

/**
 * URL of a link's QR image (`GET /v1/admin/links/:id/qr`) — for `<img>`
 * previews and download anchors rather than a JSON fetcher. Admin-authed via
 * the session cookie; first render lazy-mints the link's scan row.
 */
export function linkQrUrl(
  id: string,
  opts?: { format?: "svg" | "png"; size?: number; transparent?: boolean },
): string {
  const params = new URLSearchParams();
  if (opts?.format) params.set("format", opts.format);
  if (opts?.size) params.set("size", String(opts.size));
  if (opts?.transparent) params.set("transparent", "true");
  const qs = params.toString();
  return `${config.baseUrl}/v1/admin/links/${encodeURIComponent(id)}/qr${
    qs ? `?${qs}` : ""
  }`;
}

// --- Campaigns (broadcasts) ----------------------------------------------

/**
 * A campaign lifecycle status. `scheduled` sends at `scheduledAt` (cancelable
 * until then); a cancel also works mid-`sending` (stops at the next chunk of
 * 100 — already-dispatched emails are not recalled) and mid-`waiting`.
 * `waiting` = a multi-step campaign between waves — non-terminal, resumes at
 * `nextStepAt`. `sent`/`canceled`/`failed`/`expired` are terminal. `expired` =
 * a code-defined campaign whose sendAt had already passed when it was first
 * deployed (never sent).
 */
export type CampaignStatus =
  | "scheduled"
  | "queued"
  | "sending"
  | "waiting"
  | "sent"
  | "failed"
  | "canceled"
  | "expired";

/**
 * One normalized `where` condition on a send step — core `ConditionEval`
 * data, stored verbatim in the steps blob. Loosely mirrored (like
 * `JourneyCondition`): Studio only reads the fields it renders as chips.
 */
export type CampaignStepCondition = {
  type: string;
  /** email_engagement / event / channel_identity check discriminant. */
  check?: string;
  /** email_engagement only; absent = "any prior send of THIS campaign". */
  templateKey?: string;
  eventName?: string;
  connector?: string;
  property?: string;
  operator?: string;
  value?: unknown;
};

/** A per-recipient email wave in a multi-step campaign. */
export type CampaignSendStep = {
  kind: "send";
  template: string;
  props?: Record<string, unknown>;
  subject?: string;
  from?: string;
  /** Cohort filter for this wave; conditions AND together. Absent = everyone. */
  where?: CampaignStepCondition[];
};

/** A durable gap between waves — the campaign sits `waiting` while it elapses. */
export type CampaignWaitStep = {
  kind: "wait";
  duration: { hours?: number; minutes?: number; seconds?: number };
};

export type CampaignStep = CampaignSendStep | CampaignWaitStep;

/**
 * One broadcast row from `GET /v1/admin/campaigns`. Mirrors the engine's
 * campaign schema. Campaigns are authored in code / via the API — Studio only
 * observes them and can cancel one that is still in flight.
 */
export type Campaign = {
  id: string;
  name: string;
  status: CampaignStatus;
  audienceKind: "list" | "bucket";
  audienceId: string;
  templateKey: string;
  /** Per-campaign subject override; null = the template's own subject. */
  subject: string | null;
  /** Per-campaign from override; null = the configured default sender. */
  fromEmail: string | null;
  /** Dispatch counters — CUMULATIVE across waves on a multi-step campaign. */
  totalRecipients: number;
  sentCount: number;
  skippedCount: number;
  failedCount: number;
  /**
   * Authored wave steps, verbatim from the campaign's steps blob. Null = a
   * legacy single-send campaign (equivalent to one send step).
   */
  steps: CampaignStep[] | null;
  /** The step executing now (or, while `waiting`, the next one to execute). */
  currentStep: number;
  /** When the pending wait elapses and the next wave fires; null unless waiting. */
  nextStepAt: string | null;
  scheduledAt: string | null;
  canceledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type CampaignListFilters = {
  /** One or more statuses; joined to the CSV `status` query param. */
  status?: CampaignStatus[];
  limit?: number;
  offset?: number;
};

export function listCampaigns(filters: CampaignListFilters = {}) {
  return api.get<{ campaigns: Campaign[]; hasMore: boolean }>(
    "/v1/admin/campaigns",
    {
      query: {
        status: filters.status?.length ? filters.status.join(",") : undefined,
        limit: filters.limit,
        offset: filters.offset,
      },
    },
  );
}

export function getCampaign(id: string) {
  return api.get<Campaign>(`/v1/admin/campaigns/${encodeURIComponent(id)}`);
}

/**
 * Per-step slice of a multi-step campaign's stats, attributed via the
 * step-scoped send keys. Send steps carry that wave's engagement funnel
 * (`durationMs` null); wait steps carry only `durationMs` (counters zero).
 */
export type CampaignStepStats = {
  index: number;
  kind: "send" | "wait";
  templateKey: string | null;
  durationMs: number | null;
  sends: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  failed: number;
  lastSentAt: string | null;
};

/**
 * Post-dispatch engagement for one campaign, aggregated from its email sends.
 * The campaign row itself knows sent/skipped/failed at dispatch time; this
 * knows what happened to the mail afterwards (first-party opens/clicks plus
 * provider delivered/bounced/complained webhooks).
 */
export type CampaignStats = {
  sends: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  failed: number;
  lastSentAt: string | null;
  /** Only on multi-step campaigns: one entry per authored step, in order. */
  steps?: CampaignStepStats[];
};

export function getCampaignStats(id: string) {
  return api.get<CampaignStats>(
    `/v1/admin/campaigns/${encodeURIComponent(id)}/stats`,
  );
}

/**
 * Cancel a `scheduled`, `queued`, or `sending` campaign. Mid-send cancel stops
 * at the next chunk boundary; already-dispatched sends are not recalled.
 * Terminal campaigns reject with a 409.
 */
export function cancelCampaign(id: string) {
  return api.post<Campaign>(
    `/v1/admin/campaigns/${encodeURIComponent(id)}/cancel`,
  );
}

// --- Flags (native feature flags — OPERATOR-editable) --------------------

/**
 * One multivariate arm of a flag. `value` is any JSON (the served value);
 * `weight` is a non-negative relative number (the engine normalizes by the
 * cumulative sum). Empty for a boolean flag.
 */
export type FlagVariant = {
  key: string;
  value: unknown;
  weight: number;
};

/**
 * One PROPERTY-leaf targeting predicate — the shared PropertyCondition
 * vocabulary (a flag reuses it rather than inventing a condition type). `unary`
 * operators (`exists`/`not_exists`) carry no `value`.
 */
export type FlagTargetingCondition = {
  type: "property";
  property: string;
  operator: string;
  value?: string | number | boolean;
};

/**
 * PURE snapshot-backed membership leaf — the contact is (or, with `negate`, is
 * NOT) an active member of a bucket. Mirrors the engine `BucketCondition`.
 */
export type FlagBucketCondition = {
  type: "bucket";
  bucketId: string;
  negate?: boolean;
};

/**
 * PURE snapshot-backed journey-state leaf — the contact is enrolled (`active`)
 * in, or has completed, a journey. Mirrors the engine `JourneyCondition`.
 */
export type FlagJourneyCondition = {
  type: "journey";
  journeyId: string;
  state: "active" | "completed";
  negate?: boolean;
};

/**
 * PURE snapshot-backed CRM deal leaf — `won`/`open`, or a deal at a canonical
 * `stage`. Mirrors the engine `DealCondition`.
 */
export type FlagDealCondition = {
  type: "deal";
  predicate: "won" | "open" | "stage";
  stage?: string;
  negate?: boolean;
};

/**
 * SERVER-ONLY scan leaf — an event existence / count check over `user_events`.
 * Resolves only on the secret-key evaluate path; short-circuits to `false` on
 * the browser read. Mirrors the engine `EventCondition`.
 */
export type FlagEventCondition = {
  type: "event";
  eventName: string;
  check: "exists" | "not_exists" | "count";
  operator?: "gt" | "gte" | "lt" | "lte" | "eq";
  value?: number;
  within?: { hours?: number; minutes?: number; seconds?: number };
};

/**
 * SERVER-ONLY scan leaf — an email open/click engagement check. Resolves only
 * on the secret-key evaluate path (false on the browser read). Mirrors the
 * engine `EmailEngagementCondition`.
 */
export type FlagEmailEngagementCondition = {
  type: "email_engagement";
  templateKey: string;
  check: "opened" | "clicked" | "not_opened" | "not_clicked";
};

/**
 * Every non-composite targeting leaf a flag can carry: the PURE snapshot-backed
 * set (`property`/`bucket`/`journey`/`deal`) plus the SERVER-ONLY scan set
 * (`event`/`email_engagement`).
 */
export type FlagTargetingLeaf =
  | FlagTargetingCondition
  | FlagBucketCondition
  | FlagJourneyCondition
  | FlagDealCondition
  | FlagEventCondition
  | FlagEmailEngagementCondition;

/**
 * An AND/OR group of targeting nodes. Children are themselves {@link
 * FlagTargeting} nodes, so groups nest arbitrarily. Mirrors the engine's
 * `FlagTargetingComposite` (@hogsend/core) — kept as a local type because the
 * Studio ships as a standalone SPA `dist` and does not bundle engine source.
 */
export type FlagTargetingComposite = {
  type: "composite";
  operator: "and" | "or";
  conditions: FlagTargeting[];
};

/**
 * A flag's targeting condition TREE: any {@link FlagTargetingLeaf} or an AND/OR
 * COMPOSITE of further nodes. Empty targeting matches everyone. Mirrors the
 * engine's `FlagTargeting`. NOTE: the stored/serialized shape may still be a
 * legacy bare `FlagTargetingCondition[]` (implicit AND) — readers accept BOTH
 * (see `Flag`).
 */
export type FlagTargeting = FlagTargetingLeaf | FlagTargetingComposite;

export type FlagType = "boolean" | "multivariate";

/**
 * One ordered targeting rule of a flag — a `targeting` tree plus its own
 * `rollout` percent. The engine evaluates a flag's condition sets IN ORDER and
 * the FIRST set whose targeting matches AND whose per-set rollout admits the
 * contact turns the flag on. Mirrors the engine's `ConditionSet` (@hogsend/core).
 * `targeting` accepts the tree form OR a legacy bare `FlagTargetingCondition[]`.
 */
export type FlagConditionSet = {
  description?: string;
  targeting: FlagTargeting | FlagTargetingCondition[];
  rollout: number;
};

/**
 * One row of `GET /v1/admin/flags` — a native, DB-backed feature flag. Mirrors
 * the engine flag schema (routes/admin/flags.ts). Unlike observe-only groups
 * and buckets, flags are OPERATOR-editable from Studio: toggling `enabled` or
 * editing the `rollout`/targeting takes effect without a redeploy — that live
 * switch is the whole point. `defaultValue` is served when the flag is disabled,
 * targeting fails, or the contact is outside the rollout slice.
 */
export type Flag = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  type: FlagType;
  variants: FlagVariant[];
  defaultValue: unknown;
  /**
   * The targeting predicate. Serialized as the Phase-1 tree, but a legacy flag
   * may still carry a bare `FlagTargetingCondition[]` (implicit AND) — the
   * editor normalizes both on load.
   */
  targeting: FlagTargeting | FlagTargetingCondition[];
  rollout: number;
  /**
   * The ordered targeting rules (first matching set wins). Always ≥1 — a flag
   * that predates condition sets is synthesized as a single set from the legacy
   * `targeting`+`rollout` columns server-side.
   */
  conditionSets: FlagConditionSet[];
  /** Provenance seam ("native" today). */
  origin: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function listFlags(includeArchived = false) {
  return api.get<{ flags: Flag[] }>("/v1/admin/flags", {
    query: { includeArchived: includeArchived ? "true" : undefined },
  });
}

/** `key`/`name`/`type` are required; everything else has a table-level default. */
export type FlagCreateBody = {
  key: string;
  name: string;
  description?: string;
  enabled?: boolean;
  type: FlagType;
  variants?: FlagVariant[];
  defaultValue?: unknown;
  targeting?: FlagTargeting | FlagTargetingCondition[];
  rollout?: number;
  /** Ordered targeting rules — wins over the legacy `targeting`+`rollout` pair. */
  conditionSets?: FlagConditionSet[];
};

export function createFlag(body: FlagCreateBody) {
  return api.post<{ flag: Flag }>("/v1/admin/flags", { json: body });
}

/** Every field optional — `key` is immutable and deliberately omitted. */
export type FlagUpdateBody = {
  key?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  type?: FlagType;
  variants?: FlagVariant[];
  defaultValue?: unknown;
  targeting?: FlagTargeting | FlagTargetingCondition[];
  rollout?: number;
  /** Ordered targeting rules — wins over the legacy `targeting`+`rollout` pair. */
  conditionSets?: FlagConditionSet[];
};

export function updateFlag(id: string, body: FlagUpdateBody) {
  return api.patch<{ flag: Flag }>(
    `/v1/admin/flags/${encodeURIComponent(id)}`,
    { json: body },
  );
}

/** Archive (soft-delete) a flag — frees its key for reuse. */
export function archiveFlag(id: string) {
  return api.delete<{ archived: boolean }>(
    `/v1/admin/flags/${encodeURIComponent(id)}`,
  );
}

// --- Targeting catalog (reusable condition-builder raw material) ----------

/** One property operator with a human label; `unary` ops take no value. */
export type TargetingOperator = {
  value: string;
  label: string;
  unary: boolean;
};

/** An `{ id, name }` pick-list entry (a bucket / journey / campaign). */
export type TargetingIdName = { id: string; name: string };

/**
 * One event-name entry in the catalog — the merged observed + declared usage
 * (mirrors the engine's `eventNameEntrySchema`). `usedBy` lists where the name
 * is declared as a trigger.
 */
export type TargetingEventName = {
  name: string;
  occurrences: number;
  lastSeenAt: string | null;
  usedBy: string[];
};

/**
 * `GET /v1/admin/targeting/catalog` — the raw material a condition builder needs
 * to compose EVERY targeting leaf: the distinct contact-property keys (capped,
 * sorted) + operator vocabulary (property leaves), plus the id/name pick-lists
 * for the snapshot leaves (buckets, journeys, deal stages) and the scan leaves
 * (event names, campaigns). Named generically because the same vocabulary feeds
 * any targeting UI.
 */
export type TargetingCatalog = {
  properties: string[];
  operators: TargetingOperator[];
  buckets: TargetingIdName[];
  journeys: TargetingIdName[];
  dealStages: string[];
  events: TargetingEventName[];
  campaigns: TargetingIdName[];
};

export function getTargetingCatalog() {
  return api.get<TargetingCatalog>("/v1/admin/targeting/catalog");
}

/**
 * `POST /v1/admin/targeting/count` — estimate how many live contacts a targeting
 * tree matches, over a bounded most-recently-updated sample. `matched`/`sampled`
 * are the exact sample counts; `estimatedTotal` scales them by the live-contact
 * total (exact when the sample covers every contact).
 */
export type TargetingCount = {
  matched: number;
  sampled: number;
  estimatedTotal: number;
};

export function getTargetingCount(
  targeting: FlagTargeting | FlagTargetingCondition[],
) {
  return api.post<TargetingCount>("/v1/admin/targeting/count", {
    json: { targeting },
  });
}

// --- Query keys ----------------------------------------------------------

export const qk = {
  overview: ["overview"] as const,
  emails: (filters: EmailListFilters) => ["emails", filters] as const,
  email: (id: string) => ["email", id] as const,
  events: (filters: EventListFilters) => ["events", filters] as const,
  event: (id: string) => ["event", id] as const,
  templates: ["templates"] as const,
  templatePreview: (key: string) => ["template-preview", key] as const,
  templateReport: (key: string) => ["template-report", key] as const,
  journeyMetrics: ["journey-metrics"] as const,
  journeys: ["journeys"] as const,
  journeyFunnel: (id: string) => ["journey-funnel", id] as const,
  journey: (id: string) => ["journey", id] as const,
  journeyStates: (id: string, filter: JourneyStatesFilter) =>
    ["journey-states", id, filter] as const,
  journeyState: (id: string, stateId: string) =>
    ["journey-state", id, stateId] as const,
  journeyTemplates: (id: string) => ["journey-templates", id] as const,
  journeyImpact: (id: string, days: number) =>
    ["journey-impact", id, days] as const,
  impactOverview: (days: number) => ["impact-overview", days] as const,
  journeyGraph: (id: string) => ["journey-graph", id] as const,
  blueprints: ["blueprints"] as const,
  blueprint: (id: string) => ["blueprint", id] as const,
  blueprintGraph: (id: string) => ["blueprint-graph", id] as const,
  buckets: ["buckets"] as const,
  bucketMetrics: ["bucket-metrics"] as const,
  bucket: (id: string) => ["bucket", id] as const,
  bucketTrend: (id: string) => ["bucket-trend", id] as const,
  groups: (filters: GroupListFilters) => ["groups", filters] as const,
  group: (groupType: string, groupKey: string) =>
    ["group", groupType, groupKey] as const,
  groupMembers: (
    groupType: string,
    groupKey: string,
    filter: { limit?: number; offset?: number },
  ) => ["group-members", groupType, groupKey, filter] as const,
  contacts: (filters: ContactListFilters) => ["contacts", filters] as const,
  contact: (id: string) => ["contact", id] as const,
  contactActivity: (id: string) => ["contact-activity", id] as const,
  contactTimeline: (id: string) => ["contact-timeline", id] as const,
  lists: ["lists"] as const,
  suppressions: (type: string) => ["suppressions", type] as const,
  apiKeys: ["api-keys"] as const,
  fxSetting: ["fx-setting"] as const,
  domain: ["domain"] as const,
  readiness: ["readiness"] as const,
  integrations: ["integrations"] as const,
  discordConnectInfo: ["discord-connect-info"] as const,
  links: (type: string) => ["links", type] as const,
  link: (id: string) => ["link", id] as const,
  qrCodes: () => ["links", "qr-lens"] as const,
  campaigns: (filters: CampaignListFilters) => ["campaigns", filters] as const,
  campaign: (id: string) => ["campaign", id] as const,
  campaignStats: (id: string) => ["campaign-stats", id] as const,
  flags: (includeArchived: boolean) => ["flags", includeArchived] as const,
  targetingCatalog: ["targeting-catalog"] as const,
  targetingCount: (targeting: FlagTargeting | FlagTargetingCondition[]) =>
    ["targeting-count", targeting] as const,
  deals: (filters: DealListFilters) => ["deals", filters] as const,
  dealsStats: (funnel?: string) => ["deals-stats", funnel ?? null] as const,
  dealsTimeseries: (days: number, funnel?: string) =>
    ["deals-timeseries", days, funnel ?? null] as const,
  conversions: (filters: ConversionListFilters) =>
    ["conversions", filters] as const,
  conversionsStats: ["conversions-stats"] as const,
  conversionTiming: (
    definitionId: string,
    anchorType: TimingAnchorType,
    anchorId: string,
    days: number,
  ) => ["conversion-timing", definitionId, anchorType, anchorId, days] as const,
  attribution: (
    days: number,
    definitionId?: string,
    groupBy?: AttributionGroupBy,
    scope?: { journeyId?: string; campaignId?: string },
  ) =>
    [
      "attribution",
      days,
      definitionId ?? null,
      groupBy ?? "channel",
      scope?.journeyId ?? null,
      scope?.campaignId ?? null,
    ] as const,
};

// ---------------------------------------------------------------------------
// Deals — the revenue ledger
// ---------------------------------------------------------------------------

export type Deal = {
  id: string;
  provider: string;
  externalId: string;
  contactId: string;
  contactEmail: string | null;
  pipelineId: string | null;
  funnelId: string | null;
  stageId: string | null;
  canonicalStage: string;
  value: number | null;
  currency: string | null;
  quotedAt: string | null;
  soldAt: string | null;
  lostAt: string | null;
  lastStageAt: string | null;
  createdAt: string;
};

export type DealSort =
  | "lastStageAt"
  | "value"
  | "stage"
  | "provider"
  | "contactEmail"
  | "quotedAt"
  | "soldAt"
  | "createdAt";

export type DealListFilters = {
  stage?: string;
  provider?: string;
  funnel?: string;
  search?: string;
  minValue?: number;
  sort?: DealSort;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

export type DealsStats = {
  /** The funnel these stats are scoped to (older engines omit it). */
  funnelId?: string;
  /** Every registered funnel — the switcher catalog (older engines omit). */
  funnels?: Array<{ id: string; name: string | null; stageOrder: string[] }>;
  /** Configured ladder in rank order, `lost` last (older engines omit it). */
  stageOrder?: string[];
  stages: Record<string, number>;
  /** True funnel: deals that reached each stage or beyond (older engines omit). */
  reached?: Record<string, number>;
  currencies: Array<{
    currency: string | null;
    soldRevenue30d: number;
    soldRevenueLifetime: number;
    soldCount30d: number;
    soldCountLifetime: number;
    openPipelineValue: number;
    openPipelineCount: number;
    averageOrderValue: number | null;
  }>;
  avgTimeToCloseHours: number | null;
};

export function listDeals(filters: DealListFilters) {
  return api.get<{
    deals: Deal[];
    total: number;
    limit: number;
    offset: number;
  }>("/v1/admin/deals", {
    query: {
      stage: filters.stage || undefined,
      provider: filters.provider || undefined,
      funnel: filters.funnel || undefined,
      search: filters.search || undefined,
      minValue: filters.minValue,
      sort: filters.sort,
      dir: filters.dir,
      limit: filters.limit ?? 50,
      offset: filters.offset ?? 0,
    },
  });
}

export function getDealsStats(funnel?: string) {
  return api.get<DealsStats>("/v1/admin/deals/stats", {
    query: { funnel: funnel || undefined },
  });
}

export type SeriesPoint = { date: string; value: number };

export type DealsTimeseries = {
  days: number;
  revenue: Array<{ currency: string | null; points: SeriesPoint[] }>;
  counts: {
    sold: SeriesPoint[];
    quoted: SeriesPoint[];
    created: SeriesPoint[];
  };
};

export function getDealsTimeseries(days = 60, funnel?: string) {
  return api.get<DealsTimeseries>("/v1/admin/deals/timeseries", {
    query: { days, funnel: funnel || undefined },
  });
}

export type ConversionDispatchState = {
  destinationId: string;
  status: string;
  attempts: number;
  lastError: string | null;
  deliveredAt: string | null;
};

export type ConversionRow = {
  id: string;
  definitionId: string;
  contactId: string;
  contactEmail: string | null;
  value: number | null;
  currency: string | null;
  occurredAt: string;
  dispatches: ConversionDispatchState[];
};

export type ConversionListFilters = {
  definitionId?: string;
  dispatchStatus?: "pending" | "delivered" | "failed";
  sort?: "occurredAt" | "value" | "definitionId";
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

export function listConversions(filters: ConversionListFilters) {
  return api.get<{
    conversions: ConversionRow[];
    total: number;
    limit: number;
    offset: number;
  }>("/v1/admin/conversions", {
    query: {
      definitionId: filters.definitionId || undefined,
      dispatchStatus: filters.dispatchStatus,
      sort: filters.sort,
      dir: filters.dir,
      limit: filters.limit ?? 50,
      offset: filters.offset ?? 0,
    },
  });
}

/** The rollup dimension (impact plan §1.5). */
export type AttributionGroupBy =
  | "channel"
  | "journey"
  | "campaign"
  | "template";

export type AttributionRow = {
  model: string;
  /** The grouped dimension's value; null = credits with no scope on it. */
  key: string | null;
  /** Server-resolved label where the key is opaque (campaign name). */
  label: string | null;
  /** Back-compat: present when groupBy=channel (older engines always). */
  channel?: string;
  currency: string | null;
  value: number;
  conversions: number;
  touches: number;
};

/** Fired-vs-attributed coverage per currency — the "doesn't add up" killer. */
export type AttributionTotals = {
  currency: string | null;
  value: number;
  conversions: number;
  attributedValue: number;
  attributedConversions: number;
};

/** Cross-scope overlap read-out (§2.3) — the double-count nobody else shows. */
export type AttributionOverlap = {
  currency: string | null;
  conversions: number;
  multiScopeConversions: number;
  value: number;
  scopeSummedValue: number;
};

/**
 * Influenced (§3.1) — model-invariant coverage per scope key: conversions
 * with ≥1 touch from the scope, at FULL value. Multi-counted across scopes
 * by design (reach, not credit — never sums to total).
 */
export type AttributionInfluenced = {
  key: string;
  label: string | null;
  currency: string | null;
  conversions: number;
  value: number;
};

export function getAttribution(
  days = 90,
  definitionId?: string,
  groupBy: AttributionGroupBy = "channel",
  scope?: { journeyId?: string; campaignId?: string },
) {
  return api.get<{
    days: number;
    groupBy?: AttributionGroupBy;
    rows: AttributionRow[];
    /** Older engines omit it. */
    totals?: AttributionTotals[];
    /** Older engines omit it. */
    overlap?: AttributionOverlap[];
    /** Older engines omit it. */
    influenced?: AttributionInfluenced[];
  }>("/v1/admin/attribution", {
    query: {
      days,
      definitionId: definitionId || undefined,
      groupBy,
      journeyId: scope?.journeyId,
      campaignId: scope?.campaignId,
    },
  });
}

export type ConversionsStats = {
  definitions: Array<{
    definitionId: string;
    count30d: number;
    countLifetime: number;
    lastFiredAt: string | null;
  }>;
  destinations: Array<{
    destinationId: string;
    pending: number;
    delivered: number;
    failed: number;
  }>;
};

export function getConversionsStats() {
  return api.get<ConversionsStats>("/v1/admin/conversions/stats");
}

// ---------------------------------------------------------------------------
// Impact — journey lift/versions/variants + program overview (impact
// experiments spec D4.4/D4.5). Types are written MECHANICALLY from the frozen
// engine Zod schemas in packages/engine/src/routes/admin/journey-impact.ts
// and routes/admin/impact.ts — the engine owns the shapes; edit there first.
// ---------------------------------------------------------------------------

/** Mirrors the engine LiftVerdict (packages/engine/src/lib/lift-stats.ts). */
export type LiftVerdict = {
  /** ALREADY ×100 by the engine (lift-stats.ts:109-111) — render with
   * toFixed(1), NEVER formatPercent. Null when control converts at 0%. */
  liftPercent: number | null;
  /** P(treatment > control), 0–1 fraction; null ONLY when suppressed. */
  winProbability: number | null;
  /** Under 10 combined conversions — render counts, never a percentage. */
  suppressed: boolean;
  /** Either cohort under 100 contacts — warn loudly, never hide. */
  smallSample: boolean;
};

export type CohortCounts = {
  contacts: number;
  converters: number;
  /** 0–1 fraction — render with formatPercent. */
  rate: number;
};

/** Counts + per-currency conversion value (never summed across currencies). */
export type ImpactCohort = CohortCounts & {
  value: Array<{ currency: string | null; value: number }>;
};

export type ImpactGoal = {
  /** Effective conversion definition scoping every outcome; null = any. */
  definitionId: string | null;
  source: "query" | "goal" | "none";
  /** Registered definition's display name; null when unscoped/unknown. */
  name: string | null;
};

export type ImpactOverall = {
  /** True ONLY when a held-out cohort exists (causal-language law). When
   * false, `treatment` IS the observational read. */
  causal: boolean;
  treatment: ImpactCohort;
  control: ImpactCohort;
  /** Null when control.contacts === 0 (no Beta(1,1) ghost verdicts). */
  verdict: LiftVerdict | null;
};

export type ImpactVersion = {
  /** journey_version_hash; null = the pre-versioning bucket. Treat a new
   * hash as "possible new version" — toolchain bumps can fork it. */
  hash: string | null;
  /** Latest-by-created_at label on this hash's rows. Hash is truth. */
  label: string | null;
  firstEnrolledAt: string | null;
  lastEnrolledAt: string | null;
  enrollments: number;
  converters: number;
  rate: number;
  /** Contemporaneous holdout lift (control = held_out rows with the SAME
   * hash). Null when this version diverted nobody. */
  liftVsControl: ({ causal: true; control: CohortCounts } & LiftVerdict) | null;
};

export type ImpactVariantArm = {
  arm: string;
  enrollments: number;
  converters: number;
  rate: number;
  /** Observational engagement funnel for this arm (email_sends). */
  engagement: {
    causal: false;
    sends: number;
    opened: number;
    clicked: number;
  };
  /** Arm cohort vs the WHOLE held-out cohort; null without holdout. */
  liftVsControl: ({ causal: true } & LiftVerdict) | null;
};

export type ImpactVariant = { key: string; arms: ImpactVariantArm[] };

export type JourneyImpact = {
  journeyId: string;
  days: number;
  goal: ImpactGoal;
  /** Authored holdout config; null when none or unregistered. */
  holdout: { percent: number } | null;
  /** Identity of the CURRENT deployed definition; null when unregistered. */
  currentVersionHash: string | null;
  currentVersionLabel: string | null;
  overall: ImpactOverall;
  /** Newest version first (server order). */
  versions: ImpactVersion[];
  variants: ImpactVariant[];
};

export function getJourneyImpact(id: string, days = 90) {
  return api.get<JourneyImpact>(
    `/v1/admin/journeys/${encodeURIComponent(id)}/impact`,
    { query: { days } },
  );
}

/** Vendored from @hogsend/attribution ATTRIBUTION_MODELS — Studio ships a
 * standalone SPA dist and does not bundle engine packages. */
export type ImpactAttributionModel =
  | "first"
  | "last"
  | "lastNonDirect"
  | "linear"
  | "timeDecay"
  | "positionU"
  | "positionW"
  | "blended";

export type ImpactOverviewLift = {
  causal: true;
  control: CohortCounts;
} & LiftVerdict;

export type ImpactJourneyRow = {
  journeyId: string;
  /** Registry name; null for blueprint/removed ids seen only in data. */
  name: string | null;
  registered: boolean;
  versionLabel: string | null;
  goalDefinitionId: string | null;
  /** Null when no holdout configured or journey unregistered — lets the UI
   * split "no holdout" from "holdout on, no held-out contacts yet". */
  holdoutPercent: number | null;
  observational: {
    causal: false;
    enrollments: number;
    converters: number;
    rate: number;
  };
  attributed: {
    causal: false;
    model: ImpactAttributionModel;
    values: Array<{
      currency: string | null;
      value: number;
      conversions: number;
    }>;
  };
  /** Present only where a held-out cohort exists in the window. */
  lift: ImpactOverviewLift | null;
};

export type ImpactCampaignRow = {
  campaignId: string;
  name: string;
  status: string;
  sends: number;
  delivered: number;
  opened: number;
  clicked: number;
  attributed: Array<{
    currency: string | null;
    value: number;
    conversions: number;
  }>;
};

export type ImpactGlobalControl =
  | { state: "off" }
  | {
      state: "skipped";
      reason: "too_many_contacts";
      percent: number;
      contactCount: number;
    }
  | ({
      state: "computed";
      causal: true;
      percent: number;
      contactsScanned: number;
      treatment: CohortCounts;
      control: CohortCounts;
    } & LiftVerdict);

export type ImpactOverview = {
  days: number;
  model: ImpactAttributionModel;
  rankedBy: "converters";
  journeys: ImpactJourneyRow[];
  /** Correlational-only, whole section — no lift, no win probability. */
  campaigns: { causal: false; rows: ImpactCampaignRow[] };
  globalControl: ImpactGlobalControl;
};

export function getImpactOverview(days = 90) {
  return api.get<ImpactOverview>("/v1/admin/impact/overview", {
    query: { days },
  });
}

/** What each timing subject is anchored on: a journey enrollment or an event. */
export type TimingAnchorType = "journey" | "event";

/**
 * `GET /v1/admin/conversions/timing` — the time-to-conversion distribution for
 * one conversion definition, anchored on either a journey enrollment or an
 * event. `anchored` is the denominator (subjects anchored in the window),
 * `converted` the numerator (those that fired the conversion at/after their
 * anchor). `convertedWithin` are cumulative day buckets; `medianDays`/`p90Days`
 * are latency percentiles among converters (null when nobody converted).
 * `correlational` is always true — anchoring self-selects engaged contacts, so
 * "how long after" is association, not causation (holdouts are the causal lens).
 */
export type ConversionTiming = {
  definitionId: string;
  anchor: { type: TimingAnchorType; id: string };
  days: number;
  anchored: number;
  converted: number;
  rate: number;
  convertedWithin: { d1: number; d7: number; d14: number; d30: number };
  medianDays: number | null;
  p90Days: number | null;
  correlational: true;
};

export type ConversionTimingParams = {
  definitionId: string;
  anchorType: TimingAnchorType;
  anchorId: string;
  days?: number;
};

export function getConversionTiming(params: ConversionTimingParams) {
  return api.get<ConversionTiming>("/v1/admin/conversions/timing", {
    query: {
      definitionId: params.definitionId,
      anchorType: params.anchorType,
      anchorId: params.anchorId,
      days: params.days,
    },
  });
}
