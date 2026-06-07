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
}

/** Result of `emails.send`. */
export interface SendEmailResult {
  emailSendId: string;
  status: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Resource inputs
// ---------------------------------------------------------------------------

export type UpsertContactInput = Identity & {
  properties?: Record<string, unknown>;
  lists?: Record<string, boolean>;
};

export type FindContactsInput = { email: string } | { userId: string };

export type DeleteContactInput = Identity;

export type SendEventInput = Identity & {
  name: string;
  eventProperties?: Record<string, unknown>;
  contactProperties?: Record<string, unknown>;
  lists?: Record<string, boolean>;
  idempotencyKey?: string;
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
