/**
 * Code-defined campaigns (broadcasts) — a scheduled send committed to the
 * repo, mirroring `defineJourney()` / `defineList()`: write a file, deploy,
 * and the worker's boot reconciler schedules it; once sent it is retired
 * (redeploys no-op via the campaign's definition idempotency key).
 *
 * A defined campaign is NOT a new runtime — it reconciles into the same
 * `campaigns` row + durable `send-campaign` task the `POST /v1/campaigns`
 * data-plane uses, so scheduling, cancel, counts, and Studio visibility are
 * identical regardless of how the campaign was created.
 *
 * A campaign is one or more `steps` — email waves separated by durable waits
 * (`step.send` / `step.wait`), each wave a SET operation over the audience,
 * never per-user code (that's `defineJourney`). The legacy single-template
 * form stays supported forever and compiles to one send step.
 */
import {
  type CampaignSendStep,
  type CampaignStep,
  type ConditionEval,
  durationToMs,
} from "@hogsend/core";
import type { TemplateName } from "@hogsend/email";

/** Allowed campaign-id shape (mirrors list ids): alnum, dash, underscore. */
const CAMPAIGN_ID_PATTERN = /^[a-z0-9_-]+$/i;

/** Steps per campaign, inclusive. A longer sequence belongs in a journey. */
const MAX_STEPS = 10;

/** Floor on `step.wait` — below the scheduling grace windows is a footgun. */
const MIN_WAIT_MS = 5 * 60_000;

/**
 * The `campaigns.idempotency_key` namespace for code-defined campaigns. A
 * definition's row key is `campaign-def:<id>` — the reconciler resolves the
 * existing row through it, which is what makes a redeploy after `sent` a no-op
 * instead of a second blast.
 */
export const DEFINED_CAMPAIGN_KEY_PREFIX = "campaign-def:";

/** The audience selector — exactly one of `list` or `bucket` (validated). */
export type CampaignAudience = { list: string } | { bucket: string };

/**
 * The validated, fully-defaulted campaign metadata. `steps` is the canonical
 * form (always populated — the legacy single-template form compiles to one
 * send step); `template`/`props`/`subject`/`from` mirror the FIRST send step
 * so the reconciler and every single-send consumer keep working unchanged.
 * `sendAt` is always a `Date` after `defineCampaign` (authoring input also
 * accepts an ISO string); `enabled` defaults to `true`, `name` to the id.
 */
export interface CampaignMeta {
  id: string;
  name: string;
  audience: CampaignAudience;
  template: TemplateName;
  props?: Record<string, unknown>;
  subject?: string;
  from?: string;
  steps: CampaignStep[];
  sendAt: Date;
  enabled: boolean;
}

/** A defined campaign. `id` is surfaced for literal-typed consumption. */
export interface DefinedCampaign<Id extends string = string> {
  readonly meta: CampaignMeta;
  readonly id: Id;
}

/**
 * Define a campaign (broadcast) in code — a single send, or multi-step waves
 * via `steps: [step.send(…), step.wait(…), …]`. Exactly one of the two forms
 * (top-level `template` fields XOR `steps`) must be provided. Validates the
 * id shape, the audience XOR (exactly one of `list` / `bucket`), that
 * `sendAt` parses to a real instant, and the step sequence: 1–10 steps, the
 * FIRST must be a send (`sendAt` is the timing — a leading wait is redundant;
 * announcement steps are phase 2), the LAST must not be a wait, `where` only
 * on send steps after the first (the cohort must exist before it can be
 * filtered), every wait >= 5 minutes, and every `where` condition is one the
 * wave runtime can compile to bulk SQL — email_engagement, event
 * exists/not_exists, channel_identity targeting `"discord"` (the only
 * linked-identity connector in v1); `property`/`composite`/event-`count`
 * conditions are rejected HERE so they fail at deploy, not mid-campaign.
 * Whether
 * `sendAt` is still in the future is deliberately NOT checked here — that is
 * a deploy-time question the reconciler answers (a definition whose `sendAt`
 * is already stale at first reconcile becomes `expired`, never a surprise
 * blast).
 *
 * @throws if `id` is empty/malformed, both/neither of `template`/`steps` are
 * given, the step sequence breaks any rule above, the audience is not exactly
 * one of list/bucket, or `sendAt` does not parse.
 */
export function defineCampaign<const Id extends string>(
  meta: {
    id: Id;
    name?: string;
    audience: CampaignAudience;
    sendAt: Date | string;
    enabled?: boolean;
  } & (
    | {
        template: TemplateName;
        props?: Record<string, unknown>;
        subject?: string;
        from?: string;
        steps?: undefined;
      }
    | {
        steps: CampaignStep[];
        template?: undefined;
        props?: undefined;
        subject?: undefined;
        from?: undefined;
      }
  ),
): DefinedCampaign<Id> {
  const { id } = meta;

  if (!id || !CAMPAIGN_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid campaign id "${id}": must match /^[a-z0-9_-]+$/i (letters, digits, "-", "_").`,
    );
  }

  // Same widening trick as `audience` below: the XOR is re-validated at
  // runtime regardless of what the compile-time union already enforces.
  const input = meta as {
    template?: TemplateName;
    props?: Record<string, unknown>;
    subject?: string;
    from?: string;
    steps?: CampaignStep[];
  };

  let steps: CampaignStep[];
  if (input.steps !== undefined) {
    if (
      input.template !== undefined ||
      input.props !== undefined ||
      input.subject !== undefined ||
      input.from !== undefined
    ) {
      throw new Error(
        `Campaign "${id}": provide either the single-template form (template/props/subject/from) or steps — not both.`,
      );
    }
    steps = input.steps;
  } else if (input.template !== undefined) {
    steps = [
      {
        kind: "send",
        template: input.template,
        ...(input.props !== undefined ? { props: input.props } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.from !== undefined ? { from: input.from } : {}),
      },
    ];
  } else {
    throw new Error(
      `Campaign "${id}": provide a template (single send) or a steps array.`,
    );
  }

  const firstSend = validateSteps(id, steps);

  const audience = meta.audience as { list?: string; bucket?: string };
  const selectors = (audience.list ? 1 : 0) + (audience.bucket ? 1 : 0);
  if (selectors !== 1) {
    throw new Error(
      `Campaign "${id}": audience must be exactly one of { list } or { bucket }.`,
    );
  }

  const sendAt =
    meta.sendAt instanceof Date ? meta.sendAt : new Date(meta.sendAt);
  if (Number.isNaN(sendAt.getTime())) {
    throw new Error(
      `Campaign "${id}": sendAt "${String(meta.sendAt)}" is not a valid Date/ISO instant.`,
    );
  }

  return {
    meta: {
      id,
      name: meta.name ?? id,
      audience: meta.audience,
      // The stored step form keeps a plain string; authored via `step.send`
      // it was a registry-checked TemplateName.
      template: firstSend.template as TemplateName,
      ...(firstSend.props !== undefined ? { props: firstSend.props } : {}),
      ...(firstSend.subject !== undefined
        ? { subject: firstSend.subject }
        : {}),
      ...(firstSend.from !== undefined ? { from: firstSend.from } : {}),
      steps,
      sendAt,
      enabled: meta.enabled ?? true,
    },
    id,
  };
}

/**
 * Enforce the step-sequence invariants (see {@link defineCampaign}). Returns
 * the FIRST send step — guaranteed to be `steps[0]` — which seeds the
 * mirrored top-level `template`/`props`/`subject`/`from` on the meta.
 */
function validateSteps(id: string, steps: CampaignStep[]): CampaignSendStep {
  // The [0] read doubles as the non-empty check (noUncheckedIndexedAccess).
  const first = steps[0];
  if (first === undefined || steps.length > MAX_STEPS) {
    throw new Error(
      `Campaign "${id}": steps must contain 1–${MAX_STEPS} steps (got ${steps.length}).`,
    );
  }
  if (first.kind !== "send") {
    throw new Error(
      `Campaign "${id}": the first step must be a send — sendAt is the campaign's timing, so a leading wait is redundant (announcement steps are phase 2).`,
    );
  }
  if (steps[steps.length - 1]?.kind === "wait") {
    throw new Error(
      `Campaign "${id}": the last step must not be a wait — a trailing wait does nothing.`,
    );
  }

  steps.forEach((step, index) => {
    if (step.kind === "wait") {
      if (durationToMs(step.duration) < MIN_WAIT_MS) {
        throw new Error(
          `Campaign "${id}": step ${index} wait is shorter than 5 minutes — below the scheduling grace windows.`,
        );
      }
      return;
    }
    if (step.where !== undefined && index === 0) {
      throw new Error(
        `Campaign "${id}": \`where\` is not allowed on the first step — the cohort must exist before it can be filtered.`,
      );
    }
    for (const condition of step.where ?? []) {
      validateWaveCondition(id, index, condition);
    }
  });

  return first;
}

/**
 * Reject any `where` condition the wave runtime cannot compile to bulk SQL —
 * at DEFINITION time, not wave time. `CampaignWhere` accepts raw declarative
 * `ConditionEval`, so without this check a `property`/`composite`/event
 * `count` condition would pass `defineCampaign` AND the reconciler (which
 * re-checks templates, not conditions), then throw on every attempt of wave k
 * — a mid-campaign poison wave silently under-delivering every step after
 * the wait, the exact deploy-time-vs-send-time failure the reconciler exists
 * to front-run. Must mirror the runtime switch in `cohort-sql.ts`
 * `waveConditionSql` exactly.
 */
function validateWaveCondition(
  id: string,
  index: number,
  condition: ConditionEval,
): void {
  switch (condition.type) {
    case "email_engagement":
      return;
    case "event":
      if (condition.check === "count") {
        throw new Error(
          `Campaign "${id}": step ${index} \`where\` does not support event "count" checks in v1 — only exists/not_exists (c.firedEvent / c.notFiredEvent).`,
        );
      }
      return;
    case "channel_identity":
      if (condition.connector !== "discord") {
        throw new Error(
          `Campaign "${id}": step ${index} channel_identity connector "${condition.connector}" is not supported — only "discord" has a linked-identity source in v1.`,
        );
      }
      return;
    default:
      throw new Error(
        `Campaign "${id}": step ${index} \`where\` does not support "${condition.type}" conditions in v1 — only email_engagement, event (exists/not_exists), and channel_identity (the cohort-builder vocabulary).`,
      );
  }
}

/** Narrowing helper: the audience kind + id as stored on the campaigns row. */
export function audienceOf(meta: CampaignMeta): {
  audienceKind: "list" | "bucket";
  audienceId: string;
} {
  if ("list" in meta.audience) {
    return { audienceKind: "list", audienceId: meta.audience.list };
  }
  return { audienceKind: "bucket", audienceId: meta.audience.bucket };
}
