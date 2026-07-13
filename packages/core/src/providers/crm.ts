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

import { normalizeWhere } from "../conditions/index.js";
import type { PropertyCondition } from "../types/conditions.js";
import type { JourneyWhere } from "../types/journey.js";

// ---------------------------------------------------------------------------
// Canonical funnel stages
// ---------------------------------------------------------------------------

/**
 * The DEFAULT canonical funnel — what a deployment gets with no ladder
 * config. `lost` is terminal-negative, reserved, and never part of a ladder.
 * Stage progression is monotonic in the engine's deals projection: a
 * late-arriving lower-rank event never regresses a deal (heals webhook+poll
 * double-detection and out-of-order delivery).
 */
export const CANONICAL_STAGES = [
  "lead",
  "contacted",
  "survey_booked",
  "quoted",
  "sold",
] as const;

/**
 * A canonical stage id. Ladder-defined per deployment (see
 * {@link PipelineLadder}) plus the reserved terminal `"lost"` — so plain
 * `string`; the engine validates stage-map values against the configured
 * ladder at boot instead of the compiler.
 */
export type CanonicalStage = string;

/**
 * The deployment's canonical funnel: YOUR ordered stage ids (first = entry),
 * plus which stages mint the two money events. The event NAMES stay stable
 * across any ladder (`crm.deal_quoted` = "a money signal was issued",
 * `crm.deal_sold` = "revenue realized"); the ladder only picks WHICH stage
 * means which. Configured via `createHogsendClient({ crm: { stages,
 * quotedStage, soldStage } })`; defaults to {@link DEFAULT_PIPELINE_LADDER}.
 */
export interface PipelineLadder {
  /** Ordered positive stages; index = monotonic rank. Never contains "lost". */
  stages: readonly string[];
  /** The stage that mints `crm.deal_quoted`. Absent = no quote signal. */
  quotedStage?: string;
  /** The stage that mints `crm.deal_sold` (and blocks `lost` overwrites). */
  soldStage?: string;
}

export const DEFAULT_PIPELINE_LADDER: PipelineLadder = {
  stages: CANONICAL_STAGES,
  quotedStage: "quoted",
  soldStage: "sold",
};

/**
 * Validate + normalize ladder config. Custom `stages` default `soldStage` to
 * the LAST stage (a funnel ends in the sale) and `quotedStage` to a stage
 * literally named "quoted" when present; explicit designations override.
 * Throws on: empty/duplicate/reserved stage ids, or a designation not in
 * `stages`.
 */
export function normalizePipelineLadder(input?: {
  stages?: string[];
  quotedStage?: string;
  soldStage?: string;
}): PipelineLadder {
  const stages = input?.stages ?? [...DEFAULT_PIPELINE_LADDER.stages];
  if (stages.length === 0) {
    throw new Error("crm.stages must contain at least one stage");
  }
  const seen = new Set<string>();
  for (const stage of stages) {
    if (!stage || stage === "lost") {
      throw new Error(
        `crm.stages contains reserved/empty stage id ${JSON.stringify(stage)} — "lost" is the implicit terminal`,
      );
    }
    if (seen.has(stage)) {
      throw new Error(`crm.stages contains duplicate stage id "${stage}"`);
    }
    seen.add(stage);
  }
  const usingDefaults = !input?.stages;
  const quotedStage =
    input?.quotedStage ??
    (usingDefaults
      ? DEFAULT_PIPELINE_LADDER.quotedStage
      : stages.includes("quoted")
        ? "quoted"
        : undefined);
  const soldStage =
    input?.soldStage ??
    (usingDefaults ? DEFAULT_PIPELINE_LADDER.soldStage : stages.at(-1));
  for (const [name, value] of [
    ["quotedStage", quotedStage],
    ["soldStage", soldStage],
  ] as const) {
    if (value !== undefined && !seen.has(value)) {
      throw new Error(`crm.${name} "${value}" is not in crm.stages`);
    }
  }
  if (quotedStage !== undefined && quotedStage === soldStage) {
    throw new Error(
      `crm.quotedStage and crm.soldStage are both "${quotedStage}" — one stage cannot mint both money events`,
    );
  }
  return { stages, quotedStage, soldStage };
}

/**
 * Rank for monotonic progression against a ladder; `lost` maps to -1
 * (terminal-negative) and an id not in the ladder maps to `null` (unranked —
 * the projection records it without advancing).
 */
export function canonicalStageRank(
  stage: CanonicalStage,
  ladder: PipelineLadder = DEFAULT_PIPELINE_LADDER,
): number | null {
  if (stage === "lost") return -1;
  const idx = ladder.stages.indexOf(stage);
  return idx >= 0 ? idx : null;
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
   *
   * NOTE: the ENGINE never calls this. A thin-webhook provider must hydrate
   * INSIDE its own `verifyWebhook`/`parseWebhook` before returning events
   * (as the HubSpot/Attio references do) — a `crm.deal_sold` returned
   * without `value` fires its conversion at null value, and the once-per-
   * stage money event will not re-fire when the value arrives later. This
   * member exists for ops tooling and provider-internal reuse.
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
 * then the `"*"` fallback, then the provider's won/lost status hint (won =
 * the ladder's designated sold stage), else `null` (unmapped — the engine
 * surfaces it, never silently drops).
 */
export function resolveCanonicalStage(
  map: CrmStageMap | undefined,
  event: Pick<CrmStageEvent, "pipelineId" | "stageId" | "status">,
  ladder: PipelineLadder = DEFAULT_PIPELINE_LADDER,
): CanonicalStage | null {
  const fromMap =
    (event.pipelineId ? map?.[event.pipelineId]?.[event.stageId] : undefined) ??
    map?.["*"]?.[event.stageId];
  if (fromMap) return fromMap;
  if (event.status === "won") return ladder.soldStage ?? null;
  if (event.status === "lost") return "lost";
  return null;
}

// ---------------------------------------------------------------------------
// Funnels — the code-first primitive over ladders + stage maps, plural
// ---------------------------------------------------------------------------

/** The reserved funnel id the `crm.{stages,stageMaps}` sugar synthesizes. */
export const DEFAULT_FUNNEL_ID = "default";

/**
 * An EVENT stage source (docs/attribution-impact-plan.md §3.3): the stage is
 * reached when the contact emits `event` (optionally narrowed by `where`,
 * same builder journeys use). The B2C sibling of a CRM stage claim — a SaaS
 * self-serve funnel and a sales pipeline are the same primitive with
 * different stage sources.
 */
export interface EventStageSource {
  event: string;
  where?: JourneyWhere;
}

/**
 * A funnel authored like a journey: YOUR ordered stage ladder plus what
 * feeds each stage. Two stage sources, freely mixable:
 *
 *  - `sources` (CRM claims) — per provider: the stage map whose pipeline
 *    keys are ALSO the claim: this funnel owns those native pipelines
 *    (`"*"` claims the provider's remainder). Ingest routes each stage
 *    event to the funnel that claims its (provider, pipeline).
 *  - `events` (event matchers, §3.3) — stage → `{ event, where? }`; the
 *    engine writes a first-reach `funnel_progress` row at ingest. No CRM
 *    required — B2C order flows and activation ladders are pure `events`
 *    funnels.
 *
 * One deployment runs MANY funnels (residential vs commercial, sales vs
 * expansion, self-serve vs sales-led).
 */
export interface FunnelMeta {
  /** Stable id — stamped on deals (`funnel_id`) and event properties. */
  id: string;
  name?: string;
  /** Ordered positive stages; index = monotonic rank. Never "lost". */
  stages: string[];
  /** The stage that mints `crm.deal_quoted`. See {@link PipelineLadder}. */
  quotedStage?: string;
  /** The stage that mints `crm.deal_sold`. Defaults to the LAST stage. */
  soldStage?: string;
  /**
   * Per provider: native `(pipelineId|'*') → stageId → THIS funnel's stage`.
   * The pipeline keys double as the funnel's traffic claim. Optional — a
   * pure event funnel has none.
   */
  sources?: Record<string, CrmStageMap>;
  /** Event stage sources: stage → matcher (§3.3). Optional. */
  events?: Record<string, EventStageSource>;
}

/** One normalized event-stage matcher on a defined funnel. */
export interface FunnelEventStage {
  stage: string;
  /** The stage's index in the ladder (monotonic rank). */
  rank: number;
  event: string;
  /** The matcher's `where`, normalized to conditions at definition time. */
  where: PropertyCondition[] | undefined;
}

export interface DefinedFunnel {
  meta: FunnelMeta;
  /** The normalized ladder (rank order + money-stage designations). */
  ladder: PipelineLadder;
  /** Normalized `meta.events` matchers (empty for CRM-only funnels). */
  eventStages: FunnelEventStage[];
}

/**
 * Validating factory — normalizes the ladder and checks every mapped stage
 * value against it at definition time, so a typo throws with the exact path
 * (funnels are plain-string-typed; this replaces the compiler).
 */
export function defineFunnel(meta: FunnelMeta): DefinedFunnel {
  if (!meta.id) throw new Error("defineFunnel: id is required");
  const ladder = normalizePipelineLadder(meta);
  for (const [providerId, map] of Object.entries(meta.sources ?? {})) {
    for (const [pipelineId, stageEntries] of Object.entries(map)) {
      for (const [stageId, canonical] of Object.entries(stageEntries)) {
        if (canonical !== "lost" && !ladder.stages.includes(canonical)) {
          throw new Error(
            `funnel "${meta.id}" sources.${providerId}.${pipelineId}.${stageId} ` +
              `maps to "${canonical}", which is not in its stages ` +
              `[${ladder.stages.join(", ")}] (or "lost")`,
          );
        }
      }
    }
  }
  const eventStages: FunnelEventStage[] = Object.entries(meta.events ?? {}).map(
    ([stage, source]) => {
      const rank = ladder.stages.indexOf(stage);
      if (rank === -1) {
        throw new Error(
          `funnel "${meta.id}" events.${stage} is not in its stages ` +
            `[${ladder.stages.join(", ")}]`,
        );
      }
      return {
        stage,
        rank,
        event: source.event,
        where: normalizeWhere(source.where),
      };
    },
  );
  return { meta, ladder, eventStages };
}
