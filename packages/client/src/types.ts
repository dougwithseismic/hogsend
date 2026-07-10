// `@hogsend/email` is a TYPE-ONLY optional peer dependency. We reference its
// augmentable `TemplateRegistryMap` purely for compile-time typing of
// `emails.send`; nothing here is emitted at runtime (the import is fully erased
// from the JS dist).
//
// SHAPE degradation: when the consumer has NOT augmented `TemplateRegistryMap`,
// `IsEmptyRegistry` below picks the permissive `{ template: string; props? }`
// variant. RESOLUTION caveat: the emitted `.d.ts` still carries a top-level
// `import ... from "@hogsend/email"`, so a consumer who installs @hogsend/client
// WITHOUT the optional @hogsend/email peer AND type-checks with
// `skipLibCheck: false` gets TS2307 from this line. Install the peer (even just
// for types) or keep `skipLibCheck: true` (the common default). See README.
import type { TemplateRegistryMap } from "@hogsend/email";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * At least one resolvable identity key. Either `email` or `userId` (external id)
 * must be present; both may be supplied. Enforced at the type level by the union
 * and at runtime by `assertIdentity`.
 */
export type Identity =
  | { email: string; userId?: string }
  | { email?: string; userId: string };

// ---------------------------------------------------------------------------
// Client construction
// ---------------------------------------------------------------------------

export interface HogsendOptions {
  /** Base URL of the Hogsend API, e.g. `https://api.example.com`. */
  baseUrl: string;
  /** A data-plane API key (`hsk_…`) with the `ingest` scope. */
  apiKey: string;
  /** Override the global `fetch` (tests, custom agents). Defaults to `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Default `30_000`. */
  timeoutMs?: number;
  /** Extra headers merged onto every request (e.g. a tracing header). */
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Wire shapes (mirror §2.5)
// ---------------------------------------------------------------------------

/** The serialized contact shape returned by `/v1/contacts/find` (§2.5). */
export interface Contact {
  id: string;
  externalId: string | null;
  email: string | null;
  properties: Record<string, unknown>;
  // The server serializes these from `.notNull()` columns via `.toISOString()`,
  // so they are always present ISO strings — never null (§2.5 Contact shape).
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Result of a single exit-condition evaluation, returned by `/v1/events`. */
export interface ExitResult {
  journeyId: string;
  stateId: string;
  exited: boolean;
}

/** Result body of `POST /v1/events`. */
export interface IngestResult {
  stored: boolean;
  exits: ExitResult[];
  /**
   * The contact's canonical key (`external_id ?? anonymous_id ?? id`) after
   * this ingest's identity resolve — the same key outbound destinations emit
   * as `userId` and `hs_t` identity tokens resolve to. Hand it to your
   * analytics `identify()` so the session joins the person the contact's
   * email events land on, with no PII round-trip. Optional: servers on engine
   * <0.18 don't return it.
   */
  contactKey?: string;
  /**
   * Present only when the event was ingested but the (non-atomic, post-ingest)
   * list-membership write failed. The event itself is durably stored.
   */
  listsError?: string;
}

/** Result of `contacts.upsert`. */
export interface UpsertContactResult {
  id: string;
  created: boolean;
  linked: boolean;
}

/** Result of `contacts.delete`. */
export interface DeleteContactResult {
  deleted: boolean;
}

/** A list as returned by `GET /v1/lists`. */
export interface ListSummary {
  id: string;
  name: string;
  description?: string;
  defaultOptIn: boolean;
  /**
   * Whether this list is a delivery `channel` (in_app, telegram, discord…) or a
   * content `topic`. Optional — an older engine omits it (treat as `"topic"`).
   */
  kind?: "channel" | "topic";
}

/** Result of `emails.send`. */
export interface SendEmailResult {
  emailSendId: string;
  status: string;
  reason?: string;
}

/** Lifecycle status of a campaign (broadcast). */
export type CampaignStatus =
  | "scheduled"
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "canceled"
  | "expired";

/** Whether a campaign targets a list or a bucket. */
export type CampaignAudienceKind = "list" | "bucket";

/** Result of `campaigns.send` (the 202 ack from `POST /v1/campaigns`). */
export interface SendCampaignResult {
  campaignId: string;
  status: CampaignStatus;
  /** The send instant for a scheduled campaign; null for an immediate send. */
  scheduledAt?: string | null;
}

/** A campaign as returned by `GET /v1/campaigns/{id}`. */
export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  audienceKind: CampaignAudienceKind;
  audienceId: string;
  templateKey: string;
  totalRecipients: number;
  sentCount: number;
  skippedCount: number;
  failedCount: number;
  // ISO strings while pending; null until the worker sets them.
  scheduledAt: string | null;
  canceledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** Input to `campaigns.list`. All fields optional; newest first. */
export interface ListCampaignsInput {
  /** Filter to these statuses. */
  status?: CampaignStatus[];
  /** Page size, 1–200 (server default 50). */
  limit?: number;
  offset?: number;
}

/** Result of `campaigns.list`. */
export interface ListCampaignsResult {
  campaigns: Campaign[];
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Resource inputs
// ---------------------------------------------------------------------------

export type UpsertContactInput = Identity & {
  properties?: Record<string, unknown>;
  lists?: Record<string, boolean>;
  /**
   * Your analytics anon id (provider-neutral — e.g. posthog-js
   * `get_distinct_id()`). An EXTRA on top of the `Identity` union, never a third
   * identity arm: `assertIdentity` still requires `email` or `userId`. It is the
   * resolver's 2nd-precedence key, so a contact with no `external_id` gets its
   * canonical key set to this value — the browser's own anon events then join the
   * same analytics person as the server's captures with zero merge calls.
   */
  anonymousId?: string;
};

export type FindContactsInput = { email: string } | { userId: string };

export type DeleteContactInput = Identity;

export type SendEventInput = Identity & {
  name: string;
  eventProperties?: Record<string, unknown>;
  contactProperties?: Record<string, unknown>;
  lists?: Record<string, boolean>;
  idempotencyKey?: string;
  /**
   * Your analytics anon id (provider-neutral — e.g. posthog-js
   * `get_distinct_id()`). An EXTRA on top of the `Identity` union, never a third
   * identity arm: `assertIdentity` still requires `email` or `userId`. It is the
   * resolver's 2nd-precedence key, so a contact with no `external_id` gets its
   * canonical key set to this value — the browser's own anon events then join the
   * same analytics person as the server's captures with zero merge calls.
   */
  anonymousId?: string;
};

export type SubscribeInput = Identity & { list: string };

/** Result of `lists.subscribe` / `lists.unsubscribe`. */
export interface SubscribeResult {
  subscribed: boolean;
}

export interface UnsubscribeResult {
  unsubscribed: boolean;
}

// ---------------------------------------------------------------------------
// Outbound webhooks (hs.webhooks.*) — targets the ADMIN plane (full-admin key).
// ---------------------------------------------------------------------------

/**
 * The 14-event outbound catalog. MIRRORS the engine's `WEBHOOK_EVENT_TYPES`
 * (`@hogsend/engine` lib/webhook-signing.ts) — the client cannot import the
 * engine, so the union is re-declared here and MUST be kept in sync BY HAND
 * when the engine catalog changes (there is no automated drift check today).
 * The `webhook.test` sentinel is NOT a member (out-of-band).
 */
export type OutboundEventType =
  | "contact.created"
  | "contact.updated"
  | "contact.deleted"
  | "contact.unsubscribed"
  | "email.sent"
  | "email.delivered"
  | "email.opened"
  | "email.clicked"
  | "email.action"
  | "email.bounced"
  | "email.complained"
  | "journey.completed"
  | "bucket.entered"
  | "bucket.left";

/**
 * The delivery `kind` of a managed endpoint. `"webhook"` (default) is the signed
 * Standard-Webhooks POST; any other value (e.g. `"posthog"`, `"segment"`,
 * `"slack"`) is a keyed destination delivered via a server-side transform
 * adapter. The named members mirror the engine's SHIPPED destination presets
 * (`PRESET_DESTINATIONS`) — the same set the admin API now accepts as `kind` —
 * for editor autocomplete; the `(string & {})` arm keeps the union open to
 * consumer-defined kinds (`defineDestination`) and future presets.
 */
export type WebhookKind =
  | "webhook"
  | "posthog"
  | "segment"
  | "slack"
  | (string & {});

/**
 * A managed outbound webhook endpoint as returned by `/v1/admin/webhooks` list
 * + get. NEVER carries the full signing `secret` — only its display
 * `secretPrefix`. The full secret is returned exactly once, on create and
 * rotate-secret, as {@link CreatedWebhookEndpoint} / {@link RotateWebhookSecretResult}.
 */
export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  eventTypes: OutboundEventType[];
  /**
   * Safe-to-display prefix, e.g. `whsec_AbCd`. The full secret is never here.
   * Null for keyed destinations (kind !== "webhook"), which carry no secret.
   */
  secretPrefix: string | null;
  /** Delivery kind — "webhook" (signed POST) or a keyed destination. */
  kind: WebhookKind;
  /**
   * Per-destination config for keyed adapters, with credentials REDACTED by the
   * server (e.g. `config.apiKey` → "***"). Null for kind="webhook".
   */
  config: Record<string, unknown> | null;
  status: "enabled" | "disabled";
  organizationId: string | null;
  /** ISO string of the last delivery attempt, or null if never delivered. */
  lastDeliveryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The create / rotate response: a {@link WebhookEndpoint} PLUS the full signing
 * `secret` (`whsec_…`). Returned ONCE — store it now, it is never recoverable
 * from list/get. `secret` is present ONLY for kind="webhook" (keyed
 * destinations carry no secret), hence optional.
 */
export type CreatedWebhookEndpoint = WebhookEndpoint & { secret?: string };

/** Body for `hs.webhooks.create`. At least one event type is required. */
export interface CreateWebhookInput {
  url: string;
  eventTypes: OutboundEventType[];
  description?: string;
  disabled?: boolean;
  /**
   * Delivery kind. Defaults to "webhook" (the signed POST). Set to a keyed
   * destination (e.g. "posthog") to fan out via a server-side transform.
   */
  kind?: WebhookKind;
  /**
   * Per-destination config for keyed adapters, e.g. PostHog's
   * `{ apiKey, host }`. Ignored for kind="webhook".
   */
  config?: Record<string, unknown>;
}

/**
 * Body for `hs.webhooks.update` (PATCH semantics — only provided fields change).
 * `description: null` clears the description.
 */
export interface UpdateWebhookInput {
  url?: string;
  eventTypes?: OutboundEventType[];
  description?: string | null;
  disabled?: boolean;
  kind?: WebhookKind;
  /** Replace the keyed-destination config; `null` clears it. */
  config?: Record<string, unknown> | null;
}

/** Result of `hs.webhooks.rotateSecret` — the NEW full secret, returned once. */
export interface RotateWebhookSecretResult {
  id: string;
  secret: string;
  secretPrefix: string;
}

// ---------------------------------------------------------------------------
// emails.send — typed against the augmented TemplateRegistryMap, degrading to
// `template: string` + permissive props when un-augmented.
// ---------------------------------------------------------------------------

/**
 * `true` when `TemplateRegistryMap` carries no augmented keys (consumer has not
 * declared their templates). `[keyof TemplateRegistryMap] extends [never]` is
 * the distribution-safe "is `never`" check.
 */
type IsEmptyRegistry = [keyof TemplateRegistryMap] extends [never]
  ? true
  : false;

/** Recipient + envelope fields shared by every `emails.send` call. */
type SendEmailEnvelope = {
  to?: string;
  userId?: string;
  from?: string;
  subject?: string;
  replyTo?: string;
  category?: string;
  skipPreferenceCheck?: boolean;
  idempotencyKey?: string;
};

/** One `{ template, props }` variant for a single known template key. */
type TypedTemplateVariant = {
  [K in keyof TemplateRegistryMap]: SendEmailEnvelope & {
    template: K;
    props: TemplateRegistryMap[K];
  };
}[keyof TemplateRegistryMap];

/** Fallback shape when `@hogsend/email` is absent/un-augmented. */
type UntypedTemplateVariant = SendEmailEnvelope & {
  template: string;
  props?: Record<string, unknown>;
};

/**
 * Input to `emails.send`. When the consumer augments `TemplateRegistryMap`,
 * `template`/`props` are fully type-checked per known key; otherwise it degrades
 * to a permissive `{ template: string; props? }`.
 */
export type SendEmailInput = IsEmptyRegistry extends true
  ? UntypedTemplateVariant
  : TypedTemplateVariant;

// ---------------------------------------------------------------------------
// campaigns.send — exactly one of `list` | `bucket`, with `template`/`props`
// typed against the augmented TemplateRegistryMap (same degradation as emails).
// ---------------------------------------------------------------------------

/**
 * Audience selector: exactly one of `list` or `bucket` (a list id or a bucket
 * id). Modelled as a union so passing both is a type error, mirroring the
 * server's "exactly one of list|bucket required" validation.
 */
type CampaignAudience =
  | { list: string; bucket?: never }
  | { bucket: string; list?: never };

/** Envelope fields shared by every `campaigns.send` call. */
type CampaignEnvelope = {
  /** Human label for the campaign. Server defaults it when omitted. */
  name?: string;
  /** Override the default From address for this broadcast. */
  from?: string;
  /** Override the rendered subject for this broadcast. */
  subject?: string;
  /**
   * Schedule the broadcast for a future instant (Date or ISO 8601 string)
   * instead of sending immediately. Cancel any time before the send with
   * `campaigns.cancel`.
   */
  sendAt?: Date | string;
  /**
   * Client idempotency key: a retried send with the same key resolves to the
   * EXISTING campaign instead of double-blasting the audience.
   */
  idempotencyKey?: string;
};

/** One `{ template, props }` variant for a single known template key. */
type TypedCampaignTemplate = {
  [K in keyof TemplateRegistryMap]: CampaignEnvelope &
    CampaignAudience & {
      template: K;
      props: TemplateRegistryMap[K];
    };
}[keyof TemplateRegistryMap];

/** Fallback shape when `@hogsend/email` is absent/un-augmented. */
type UntypedCampaignTemplate = CampaignEnvelope &
  CampaignAudience & {
    template: string;
    props?: Record<string, unknown>;
  };

/**
 * Input to `campaigns.send`. Requires exactly one of `list` | `bucket` plus a
 * `template`. When the consumer augments `TemplateRegistryMap`,
 * `template`/`props` are fully type-checked per known key; otherwise it degrades
 * to a permissive `{ template: string; props? }`.
 */
export type SendCampaignInput = IsEmptyRegistry extends true
  ? UntypedCampaignTemplate
  : TypedCampaignTemplate;
