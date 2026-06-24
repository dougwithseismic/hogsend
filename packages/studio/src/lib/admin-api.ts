import { api } from "./api";

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
  counts: {
    active: number;
    waiting: number;
    completed: number;
    failed: number;
    exited: number;
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
  | "exited";

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
  suppress: Record<string, number>;
  counts: {
    active: number;
    waiting: number;
    completed: number;
    failed: number;
    exited: number;
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

export function listContacts(search: string | undefined) {
  return api.get<{
    contacts: Contact[];
    total: number;
    limit: number;
    offset: number;
  }>("/v1/admin/contacts", { query: { search, limit: 50 } });
}

export function getContact(id: string) {
  return api.get<{ contact: Contact; preferences: ContactPreferences }>(
    `/v1/admin/contacts/${encodeURIComponent(id)}`,
  );
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
  label: string | null;
  campaign: string | null;
  source: string | null;
  distinctId: string | null;
  createdBy: string | null;
  clickCount: number;
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
};

/** `GET /:id` — the flat link plus its recent clicks. */
export type LinkDetail = Link & {
  clicks: LinkClick[];
};

/**
 * Created link — the create route mints a `links` row + a `tracked_links` row
 * and returns the flat link (its short redirect URL is `link.url`).
 */
export type CreatedLink = Link;

export function listLinks(filters?: {
  type?: "personal" | "public";
  includeArchived?: boolean;
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
  /** Honored only when `type === "personal"` (share-safe invariant). */
  distinctId?: string;
}) {
  return api.post<CreatedLink>("/v1/admin/links", { json: body });
}

export function updateLink(
  id: string,
  body: { label?: string; campaign?: string },
) {
  return api.patch<Link>(`/v1/admin/links/${encodeURIComponent(id)}`, {
    json: body,
  });
}

/** Archive (soft-delete) a link — sets `archivedAt`; the short URL keeps working. */
export function archiveLink(id: string) {
  return api.delete<Link>(`/v1/admin/links/${encodeURIComponent(id)}`);
}

// --- Query keys ----------------------------------------------------------

export const qk = {
  overview: ["overview"] as const,
  emails: (filters: EmailListFilters) => ["emails", filters] as const,
  email: (id: string) => ["email", id] as const,
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
  buckets: ["buckets"] as const,
  bucketMetrics: ["bucket-metrics"] as const,
  bucket: (id: string) => ["bucket", id] as const,
  bucketTrend: (id: string) => ["bucket-trend", id] as const,
  contacts: (search: string) => ["contacts", search] as const,
  contact: (id: string) => ["contact", id] as const,
  contactActivity: (id: string) => ["contact-activity", id] as const,
  contactTimeline: (id: string) => ["contact-timeline", id] as const,
  suppressions: (type: string) => ["suppressions", type] as const,
  apiKeys: ["api-keys"] as const,
  domain: ["domain"] as const,
  readiness: ["readiness"] as const,
  integrations: ["integrations"] as const,
  discordConnectInfo: ["discord-connect-info"] as const,
  links: (type: string) => ["links", type] as const,
  link: (id: string) => ["link", id] as const,
};
