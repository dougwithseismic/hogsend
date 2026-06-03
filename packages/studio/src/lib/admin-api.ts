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
  resendId: string | null;
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
};
