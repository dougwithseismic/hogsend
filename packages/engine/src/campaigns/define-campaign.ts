/**
 * Code-defined campaigns (broadcasts) — a one-shot scheduled send committed to
 * the repo, mirroring `defineJourney()` / `defineList()`: write a file, deploy,
 * and the worker's boot reconciler schedules it; once sent it is retired
 * (redeploys no-op via the campaign's definition idempotency key).
 *
 * A defined campaign is NOT a new runtime — it reconciles into the same
 * `campaigns` row + durable `send-campaign` task the `POST /v1/campaigns`
 * data-plane uses, so scheduling, cancel, counts, and Studio visibility are
 * identical regardless of how the campaign was created.
 */
import type { TemplateName } from "@hogsend/email";

/** Allowed campaign-id shape (mirrors list ids): alnum, dash, underscore. */
const CAMPAIGN_ID_PATTERN = /^[a-z0-9_-]+$/i;

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
 * The validated, fully-defaulted campaign metadata. `sendAt` is always a
 * `Date` after `defineCampaign` (authoring input also accepts an ISO string);
 * `enabled` defaults to `true`, `name` to the id.
 */
export interface CampaignMeta {
  id: string;
  name: string;
  audience: CampaignAudience;
  template: TemplateName;
  props?: Record<string, unknown>;
  subject?: string;
  from?: string;
  sendAt: Date;
  enabled: boolean;
}

/** A defined campaign. `id` is surfaced for literal-typed consumption. */
export interface DefinedCampaign<Id extends string = string> {
  readonly meta: CampaignMeta;
  readonly id: Id;
}

/**
 * Define a one-shot campaign (broadcast) in code. Validates the id shape, the
 * audience XOR (exactly one of `list` / `bucket`), and that `sendAt` parses to
 * a real instant. Whether `sendAt` is still in the future is deliberately NOT
 * checked here — that is a deploy-time question the reconciler answers (a
 * definition whose `sendAt` is already stale at first reconcile becomes
 * `expired`, never a surprise blast).
 *
 * @throws if `id` is empty/malformed, the audience is not exactly one of
 * list/bucket, or `sendAt` does not parse.
 */
export function defineCampaign<const Id extends string>(meta: {
  id: Id;
  name?: string;
  audience: CampaignAudience;
  template: TemplateName;
  props?: Record<string, unknown>;
  subject?: string;
  from?: string;
  sendAt: Date | string;
  enabled?: boolean;
}): DefinedCampaign<Id> {
  const { id } = meta;

  if (!id || !CAMPAIGN_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid campaign id "${id}": must match /^[a-z0-9_-]+$/i (letters, digits, "-", "_").`,
    );
  }

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
      template: meta.template,
      ...(meta.props !== undefined ? { props: meta.props } : {}),
      ...(meta.subject !== undefined ? { subject: meta.subject } : {}),
      ...(meta.from !== undefined ? { from: meta.from } : {}),
      sendAt,
      enabled: meta.enabled ?? true,
    },
    id,
  };
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
