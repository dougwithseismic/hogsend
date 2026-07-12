/**
 * CRM provider contract — the pluggable sync layer of the revenue spine
 * (docs/revenue-attribution-plan.md §Phase 4). A `CrmProvider` is a dumb,
 * provider-neutral wire with exactly three jobs:
 *
 * 1. `pushLead` — deliver a normalized lead INTO the client's CRM;
 * 2. webhook verify/parse — translate the CRM's verbatim webhook into
 *    normalized {@link CrmStageEvent}s (NATIVE pipeline/stage ids — the
 *    ENGINE maps native → canonical stages via per-client stage-map config,
 *    never the provider);
 * 3. `poll`/`hydrate` — the reconciliation pull for CRMs whose webhooks are
 *    weak (poll) and the record fetch for CRMs whose webhook payloads omit
 *    the deal value (hydrate).
 *
 * Everything else — identity resolution, stage mapping, the deals
 * projection, conversion evaluation, ad-platform dispatch — is engine-owned.
 */

// ---------------------------------------------------------------------------
// Canonical funnel stages
// ---------------------------------------------------------------------------

/**
 * The canonical funnel every client's arbitrary pipeline maps ONTO, in rank
 * order. `lost` is terminal-negative and unranked. Stage progression is
 * monotonic in the engine's deals projection: a late-arriving lower-rank
 * event never regresses a deal (heals webhook+poll double-detection and
 * out-of-order delivery).
 */
export const CANONICAL_STAGES = [
  "lead",
  "contacted",
  "survey_booked",
  "quoted",
  "sold",
] as const;

export type CanonicalStage = (typeof CANONICAL_STAGES)[number] | "lost";

/** Rank for monotonic progression; `lost` maps to -1 (terminal-negative). */
export function canonicalStageRank(stage: CanonicalStage): number {
  if (stage === "lost") return -1;
  return CANONICAL_STAGES.indexOf(stage);
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** A deal value. `currency` is ISO-4217 alpha; absent on single-currency CRMs. */
export interface CrmMoney {
  amount: number;
  currency?: string;
}

// ---------------------------------------------------------------------------
// The normalized stage event (provider output)
// ---------------------------------------------------------------------------

/**
 * One CRM pipeline change, normalized. Providers emit NATIVE identifiers
 * verbatim (`pipelineId`/`stageId` as the CRM knows them); the engine's
 * per-client stage map resolves them to a {@link CanonicalStage} downstream.
 */
export interface CrmStageEvent {
  /** Native deal/opportunity id — the alias the engine joins on. */
  dealId: string;
  /** Native contact id, when the CRM separates contact from deal. */
  contactId?: string;
  /** Contact email when the payload carries it — the fastest identity join. */
  email?: string;
  /** Native pipeline id (multi-pipeline CRMs). */
  pipelineId?: string;
  /** Native stage id — prefer the stable id over the display name. */
  stageId: string;
  /** Native stage display name, when distinct from the id (observability). */
  stageName?: string;
  /** Won/lost hint when the CRM models it as a status besides the stage. */
  status?: "open" | "won" | "lost";
  /** Deal value when the webhook payload carries it (else `hydrate`). */
  value?: CrmMoney;
  /** When the CRM says the change happened (not when we observed it). */
  occurredAt: string;
  /** The untouched provider payload slice, for replay/audit. */
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Lead push (engine → CRM)
// ---------------------------------------------------------------------------

/** The normalized lead the engine pushes into a CRM. */
export interface CrmLeadInput {
  email?: string;
  phone?: string;
  name?: string;
  /** Flat extra fields, mapped per-client by the provider/config. */
  properties?: Record<string, unknown>;
  /** Estimated deal value, when the funnel captured one. */
  value?: CrmMoney;
}

export interface CrmPushResult {
  /** Native contact id created/updated. */
  contactId?: string;
  /** Native deal/opportunity id created, when the provider creates one. */
  dealId?: string;
}

// ---------------------------------------------------------------------------
// Identity & capabilities
// ---------------------------------------------------------------------------

export interface CrmProviderMeta {
  /**
   * Registry key AND the `:providerId` of `POST /v1/webhooks/crm/:providerId`.
   */
  id: string;
  name: string;
  description?: string;
}

export interface CrmProviderCapabilities {
  auth: "oauth" | "apiKey" | "hmac";
  /** The CRM pushes stage changes itself (vs poll-primary, e.g. Salesforce). */
  nativeStageWebhook: boolean;
  /** Webhook payload carries the deal value (GHL, Pipedrive) vs `hydrate`. */
  valueInWebhookPayload: boolean;
  /** Contact/deal upsert is atomic (no search-before-create needed). */
  atomicUpsert: boolean;
  /** Webhook setup needs a CRM-side admin (Salesforce CDC/Outbound Messages). */
  webhookConfigRequiresAdmin?: boolean;
}

// ---------------------------------------------------------------------------
// The provider contract
// ---------------------------------------------------------------------------

export interface CrmProvider {
  readonly meta: CrmProviderMeta;
  readonly capabilities: CrmProviderCapabilities;

  /**
   * Deliver a lead into the CRM. `idempotencyKey` (the engine passes the
   * lead's ingest identity) must make retries safe: use the CRM's atomic
   * upsert where it exists, else search-before-create keyed on email/phone.
   */
  pushLead(
    input: CrmLeadInput,
    opts: { idempotencyKey: string },
  ): Promise<CrmPushResult>;

  /**
   * Verify the CRM's webhook (owns its own secrets, constructed-in) and
   * normalize it into zero-or-more {@link CrmStageEvent}s. Throws on a bad
   * signature; throws `WebhookHandshakeSignal` for handshakes the route
   * should 200 without dispatch. MAY be async. `url` is the canonical public
   * URL (some CRMs sign it).
   */
  verifyWebhook(opts: {
    payload: string;
    headers: Record<string, string>;
    url: string;
  }): Promise<CrmStageEvent[]> | CrmStageEvent[];

  /** Parse an unsigned webhook payload (trusted contexts/tests). */
  parseWebhook(payload: string): CrmStageEvent[];

  /**
   * Reconciliation pull: deals changed since `cursor` (provider-defined —
   * a timestamp, a page token). The engine schedules this per provider and
   * persists `nextCursor`; events flow through the SAME normalization as the
   * webhook path, so the spine's idempotency dedups the overlap. Optional —
   * a webhook-only provider degrades to webhook-only sync.
   */
  poll?(cursor: string | null): Promise<{
    events: CrmStageEvent[];
    nextCursor: string | null;
  }>;

  /**
   * Fetch the current state of one deal — the value-by-fetch path for CRMs
   * whose webhooks only say "something changed" (HubSpot, Attio, Monday).
   */
  hydrate?(dealId: string): Promise<{
    stageId: string;
    pipelineId?: string;
    status?: "open" | "won" | "lost";
    value?: CrmMoney;
  }>;
}

/**
 * Identity factory for a {@link CrmProvider} — mirrors `defineSmsProvider`:
 * returns its argument unchanged but pins the literal shape to the contract.
 */
export function defineCrmProvider(provider: CrmProvider): CrmProvider {
  return provider;
}

// ---------------------------------------------------------------------------
// Stage maps (config-as-data: native pipeline/stage → canonical stage)
// ---------------------------------------------------------------------------

/**
 * A provider's stage map: outer key = native pipeline id (`"*"` matches any
 * pipeline), inner key = native stage id → canonical stage. Authored
 * code-first on `createHogsendClient({ crm: { stageMaps } })`; onboarding a
 * client's arbitrary pipeline is a config edit, not a deploy.
 */
export type CrmStageMap = Record<string, Record<string, CanonicalStage>>;

/**
 * Resolve a stage event to its canonical stage: exact pipeline entry first,
 * then the `"*"` fallback, then the provider's won/lost status hint, else
 * `null` (unmapped — the engine surfaces it, never silently drops).
 */
export function resolveCanonicalStage(
  map: CrmStageMap | undefined,
  event: Pick<CrmStageEvent, "pipelineId" | "stageId" | "status">,
): CanonicalStage | null {
  const fromMap =
    (event.pipelineId ? map?.[event.pipelineId]?.[event.stageId] : undefined) ??
    map?.["*"]?.[event.stageId];
  if (fromMap) return fromMap;
  if (event.status === "won") return "sold";
  if (event.status === "lost") return "lost";
  return null;
}
