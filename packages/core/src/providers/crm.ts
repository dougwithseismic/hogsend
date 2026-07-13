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
 * The deployment's canonical funnel, normalized: YOUR ordered stage ids
 * (first = entry), plus which stages mint the two money events. The event
 * NAMES stay stable across any ladder (`deal.quoted` = "a money signal was
 * issued", `deal.sold` = "revenue realized"); the ladder only picks WHICH
 * stage means which. Authored via {@link defineFunnel} stage entries (a
 * `milestone` marker on the stage itself); this is the derived internal
 * form the projection ranks against. Defaults to
 * {@link DEFAULT_PIPELINE_LADDER}.
 */
export interface PipelineLadder {
  /** Ordered positive stages; index = monotonic rank. Never contains "lost". */
  stages: readonly string[];
  /** The stage that mints `deal.quoted`. Absent = no quote signal. */
  quotedStage?: string;
  /** The stage that mints `deal.sold` (and blocks `lost` overwrites). */
  soldStage?: string;
}

export const DEFAULT_PIPELINE_LADDER: PipelineLadder = {
  stages: CANONICAL_STAGES,
  quotedStage: "quoted",
  soldStage: "sold",
};

/**
 * Validate + normalize ladder config.
 *
 * Defaults depend on `opts.defaults`:
 * - `"legacy"` (the all-string authoring form): custom `stages` default
 *   `soldStage` to the LAST stage (a pipeline ends in the sale) and
 *   `quotedStage` to a stage literally named "quoted" when present —
 *   explicit designations override.
 * - `"none"` (object stage entries): milestones are explicit-only — an
 *   absent designation genuinely means "does not mint that money event".
 *
 * Throws on: empty/duplicate/reserved stage ids, a designation not in
 * `stages`, one stage designated for both money events, or a quoted stage
 * ranked at/after the sold stage (you quote before you win).
 */
export function normalizePipelineLadder(
  input?: {
    stages?: string[];
    quotedStage?: string;
    soldStage?: string;
  },
  opts?: { defaults?: "legacy" | "none" },
): PipelineLadder {
  const stages = input?.stages ?? [...DEFAULT_PIPELINE_LADDER.stages];
  if (stages.length === 0) {
    throw new Error("stages must contain at least one stage");
  }
  const seen = new Set<string>();
  for (const stage of stages) {
    if (!stage || stage === "lost") {
      throw new Error(
        `stages contains reserved/empty stage id ${JSON.stringify(stage)} — "lost" is the implicit terminal`,
      );
    }
    if (seen.has(stage)) {
      throw new Error(`stages contains duplicate stage id "${stage}"`);
    }
    seen.add(stage);
  }
  // Legacy defaults are the generic rules — the built-in ladder contains
  // "quoted" and ends in "sold", so the no-input case needs no special arm.
  const applyLegacyDefaults = (opts?.defaults ?? "legacy") === "legacy";
  const quotedStage =
    input?.quotedStage ??
    (applyLegacyDefaults && stages.includes("quoted") ? "quoted" : undefined);
  const soldStage =
    input?.soldStage ?? (applyLegacyDefaults ? stages.at(-1) : undefined);
  for (const [name, value] of [
    ["quotedStage", quotedStage],
    ["soldStage", soldStage],
  ] as const) {
    if (value !== undefined && !seen.has(value)) {
      throw new Error(`${name} "${value}" is not in stages`);
    }
  }
  if (quotedStage !== undefined && quotedStage === soldStage) {
    throw new Error(
      `quotedStage and soldStage are both "${quotedStage}" — one stage cannot mint both money events`,
    );
  }
  if (
    quotedStage !== undefined &&
    soldStage !== undefined &&
    stages.indexOf(quotedStage) > stages.indexOf(soldStage)
  ) {
    throw new Error(
      `quotedStage "${quotedStage}" ranks after soldStage "${soldStage}" — a quote precedes the sale`,
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
   * (as the HubSpot/Attio references do) — a `deal.sold` returned
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
 * A provider's stage map: outer key = native pipeline id, inner key = native
 * stage id → canonical stage. A `"*"` pipeline key claims the provider's
 * remainder AND doubles as a per-stage fallback for the same funnel's
 * pipeline-specific bindings (a stage id missing from an exact-pipeline map
 * falls through to the `"*"` map before the won/lost status hint). The
 * `createHogsendClient({ crm: { stageMaps } })` sugar authors this shape; it
 * desugars into {@link crmPipeline} bindings on the default funnel.
 */
export type CrmStageMap = Record<string, Record<string, CanonicalStage>>;

// ---------------------------------------------------------------------------
// Funnels — the code-first, event-native primitive (plural)
// ---------------------------------------------------------------------------

/** The reserved funnel id the `crm.{stages,stageMaps}` sugar synthesizes. */
export const DEFAULT_FUNNEL_ID = "default";

/**
 * An event trigger on a funnel stage: "when the contact triggers this event
 * (optionally matching these property conditions), they move into this
 * stage." Same `{ event, where }` shape journeys, conversions, and
 * blueprints use; `where` sees the triggering event's properties (plus
 * `value`/`currency`).
 */
export type FunnelTriggerSpec =
  | string
  | { event: string; where?: JourneyWhere }
  | Array<string | { event: string; where?: JourneyWhere }>;

/**
 * Money milestones. `"quoted"` mints `deal.quoted` (the mid-funnel money
 * signal); `"won"` mints `deal.sold` (revenue realized). A funnel with no
 * `"won"` stage is non-monetary: it never mints money events and contributes
 * nothing to revenue rollups.
 */
export type FunnelMilestone = "quoted" | "won";

/**
 * One stage of a funnel. A plain string is a stage with no event trigger
 * (moved by CRM bindings or nothing at all). Object entries put the
 * semantics ON the stage they describe: its event trigger(s) and its money
 * milestone.
 *
 * Milestone defaults key on the authoring form: an all-string `stages`
 * array gets the legacy defaults (soldStage = last stage, quotedStage = a
 * stage literally named "quoted"); the moment ANY entry is an object,
 * milestones are explicit-only.
 */
export type FunnelStageEntry =
  | string
  | {
      id: string;
      /** Event trigger(s) that move a contact into this stage. */
      on?: FunnelTriggerSpec;
      milestone?: FunnelMilestone;
    };

/**
 * A producer binding — how non-event traffic (today: CRM stage changes)
 * feeds a funnel. Composable VALUES built by helpers ({@link crmPipeline},
 * or plugin-shipped wrappers), not a config tree. The declarative half
 * (`provider` + `pipeline`) is the funnel's traffic claim, introspected at
 * boot for overlap detection (exact pipeline beats `"*"`; two funnels
 * claiming the same pipeline throw). The programmable half (`resolve`)
 * translates a native stage event into THIS funnel's stage id.
 */
export interface FunnelBinding {
  /** Discriminant for future producer kinds. */
  kind: "crm";
  /** CRM provider id (`CrmProvider.meta.id`) this binding listens to. */
  provider: string;
  /** Native pipeline id claimed, or `"*"` for the provider's remainder. */
  pipeline: string;
  /**
   * Translate a native stage event into this funnel's stage id (or "lost"),
   * or `null` when the binding does not recognize it — the engine then falls
   * back to the provider's won/lost status hint, else records the native
   * stage without advancing the projection.
   */
  resolve: (
    event: Pick<CrmStageEvent, "pipelineId" | "stageId" | "status">,
  ) => CanonicalStage | null;
  /**
   * The declarative stage map, when this binding was built from one
   * (map-form {@link crmPipeline}) — retained so `defineFunnel` can validate
   * targets at boot. Callback-form bindings omit it; their outputs are
   * validated at runtime instead (unknown stage → recorded without
   * advancing).
   */
  stages?: Record<string, CanonicalStage>;
}

/**
 * Build a CRM {@link FunnelBinding}. Two forms:
 * - **Map form** — `stages: { "native-stage-id": "your-stage" }`; the flat
 *   map compiles into the resolver, and its targets are boot-validated
 *   against the funnel's ladder.
 * - **Callback form** — `resolve(event)`: arbitrary logic (the escape hatch
 *   plugins wrap to own their CRM-speak).
 */
export function crmPipeline(opts: {
  provider: string;
  pipeline: string;
  stages?: Record<string, CanonicalStage>;
  resolve?: (
    event: Pick<CrmStageEvent, "pipelineId" | "stageId" | "status">,
  ) => CanonicalStage | null;
}): FunnelBinding {
  if (!opts.provider || !opts.pipeline) {
    throw new Error("crmPipeline: provider and pipeline are required");
  }
  if (!opts.stages === !opts.resolve) {
    throw new Error(
      `crmPipeline(${opts.provider}:${opts.pipeline}): exactly one of \`stages\` (map form) or \`resolve\` (callback form) is required`,
    );
  }
  const stages = opts.stages;
  return {
    kind: "crm",
    provider: opts.provider,
    pipeline: opts.pipeline,
    resolve:
      opts.resolve ??
      ((event) =>
        // hasOwn: a native stage id like "constructor" must not resolve to
        // an inherited Object member.
        stages && Object.hasOwn(stages, event.stageId)
          ? (stages[event.stageId] ?? null)
          : null),
    ...(stages ? { stages } : {}),
  };
}

/**
 * A funnel authored like a journey: YOUR ordered stages (some carrying
 * money milestones), the events that move contacts between them, and —
 * optionally — CRM bindings feeding the same ladder. One deployment runs
 * MANY funnels; a deal belongs to exactly one.
 */
export interface FunnelMeta {
  /** Stable id — stamped on deals (`funnel_id`) and event properties. */
  id: string;
  name?: string;
  /** Ordered stages; index = monotonic rank. Never "lost". */
  stages: FunnelStageEntry[];
  /**
   * Event trigger(s) for the terminal `lost` stage. Only ever moves an
   * EXISTING open deal — a lost trigger with no open deal is a no-op.
   */
  lostOn?: FunnelTriggerSpec;
  /**
   * Ingest-source allowlist for event triggers (the forged-stage guard,
   * mirroring `defineConversion.sources`). Browser (`inapp`) events are
   * pk_-trust-tier: anyone can mint them. DEFAULT: every source EXCEPT
   * `inapp`. Pass explicit ids to narrow further, or `"any"` to accept
   * browser events too. CRM bindings are unaffected (already server-side).
   */
  sources?: string[] | "any";
  /** Producer bindings (CRM legs). See {@link FunnelBinding}. */
  bindings?: FunnelBinding[];
}

/** One normalized event→stage rule (derived from stage `on` + `lostOn`). */
export interface FunnelTransition {
  event: string;
  /** Target stage id, or "lost". */
  stageId: string;
  where?: PropertyCondition[];
}

export interface DefinedFunnel {
  meta: FunnelMeta;
  /** The normalized ladder (rank order + money-stage designations). */
  ladder: PipelineLadder;
  /** Normalized event→stage rules, `where` resolved at define time. */
  transitions: FunnelTransition[];
}

/** Event-name prefixes a funnel trigger may not listen to (self-loops —
 * `crm.` covers the pre-rename machinery output too). */
const RESERVED_TRIGGER_PREFIX = /^(deal|funnel|crm)\./;

function normalizeTriggerSpec(
  funnelId: string,
  stageId: string,
  spec: FunnelTriggerSpec,
): FunnelTransition[] {
  const items = Array.isArray(spec) ? spec : [spec];
  return items.map((item) => {
    const { event, where } =
      typeof item === "string" ? { event: item, where: undefined } : item;
    if (!event) {
      throw new Error(
        `funnel "${funnelId}" stage "${stageId}": empty event in \`on\``,
      );
    }
    if (RESERVED_TRIGGER_PREFIX.test(event)) {
      throw new Error(
        `funnel "${funnelId}" stage "${stageId}": "${event}" is funnel-machinery output (deal.*/funnel.*) and cannot be a stage trigger`,
      );
    }
    return {
      event,
      stageId,
      ...(where ? { where: normalizeWhere(where) } : {}),
    };
  });
}

/**
 * Validating factory — derives the ladder from stage entries (milestones →
 * money designations), normalizes every event trigger, and boot-validates
 * map-form binding targets, so a typo throws with the exact path (funnels
 * are plain-string-typed; this replaces the compiler).
 */
export function defineFunnel(meta: FunnelMeta): DefinedFunnel {
  if (!meta.id) throw new Error("defineFunnel: id is required");

  const entries = meta.stages.map((entry) =>
    typeof entry === "string" ? { id: entry } : entry,
  );
  const explicitMilestones = meta.stages.some(
    (entry) => typeof entry !== "string",
  );
  const milestones: Partial<Record<FunnelMilestone, string>> = {};
  for (const entry of entries) {
    if (!entry.milestone) continue;
    if (milestones[entry.milestone]) {
      throw new Error(
        `funnel "${meta.id}": milestone "${entry.milestone}" appears on both "${milestones[entry.milestone]}" and "${entry.id}" — at most one stage per milestone`,
      );
    }
    milestones[entry.milestone] = entry.id;
  }
  let ladder: PipelineLadder;
  try {
    ladder = normalizePipelineLadder(
      {
        stages: entries.map((e) => e.id),
        quotedStage: milestones.quoted,
        soldStage: milestones.won,
      },
      { defaults: explicitMilestones ? "none" : "legacy" },
    );
  } catch (error) {
    throw new Error(
      `funnel "${meta.id}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const transitions = entries.flatMap((entry) =>
    entry.on ? normalizeTriggerSpec(meta.id, entry.id, entry.on) : [],
  );
  if (meta.lostOn) {
    transitions.push(...normalizeTriggerSpec(meta.id, "lost", meta.lostOn));
  }

  const claimed = new Set<string>();
  for (const binding of meta.bindings ?? []) {
    const claim = `${binding.provider}:${binding.pipeline}`;
    if (claimed.has(claim)) {
      throw new Error(
        `funnel "${meta.id}": duplicate binding for ${claim} — one binding per (provider, pipeline)`,
      );
    }
    claimed.add(claim);
    for (const [stageId, canonical] of Object.entries(binding.stages ?? {})) {
      if (canonical !== "lost" && !ladder.stages.includes(canonical)) {
        throw new Error(
          `funnel "${meta.id}" binding ${claim}: "${stageId}" maps to ` +
            `"${canonical}", which is not in its stages ` +
            `[${ladder.stages.join(", ")}] (or "lost")`,
        );
      }
    }
  }

  return { meta, ladder, transitions };
}
