import type { CriteriaBuilder } from "../conditions/builder.js";
import type { DurationObject } from "../duration.js";
import type { PropertyCondition } from "./conditions.js";

/**
 * The builder surface available to a journey `where` function — property
 * terminals only. Trigger/exit conditions evaluate against the TRIGGERING
 * event's properties; counts, windows, and engagement belong in bucket
 * criteria or `ctx.history`, not here.
 */
export type JourneyWhereBuilder = Pick<CriteriaBuilder, "prop">;

/**
 * Authoring form of `trigger.where` / `exitOn[].where`: the stored data form
 * (`PropertyCondition[]`), or a builder function resolved ONCE at
 * `defineJourney` time into the byte-identical POJOs —
 * `where: (b) => b.prop("score").lte(6)`. The function never executes
 * per-user, so conditions stay introspectable data everywhere downstream
 * (registry, admin routes, Studio).
 */
export type JourneyWhere =
  | PropertyCondition[]
  | ((b: JourneyWhereBuilder) => PropertyCondition | PropertyCondition[]);

/**
 * What `defineJourney` ACCEPTS. The stored {@link JourneyMeta} (registry,
 * schema, HTTP) keeps plain `PropertyCondition[]` — only the authoring
 * surface widens.
 */
export interface JourneyMetaInput
  extends Omit<JourneyMeta, "trigger" | "exitOn" | "versionHash"> {
  trigger: {
    event: string;
    where?: JourneyWhere;
  };
  exitOn?: Array<{
    event: string;
    where?: JourneyWhere;
  }>;
}

export interface JourneyMeta {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;

  trigger: {
    event: string;
    where?: PropertyCondition[];
  };

  entryLimit: "once" | "once_per_period" | "unlimited";
  entryPeriod?: DurationObject;

  exitOn?: Array<{
    event: string;
    where?: PropertyCondition[];
  }>;

  /**
   * Email-preference category stamped on this journey's `sendEmail` sends
   * (overrides the template's own category, exactly as the built-in default
   * does). Must be a defined topic list or a reserved built-in category;
   * validated fail-closed at boot. Defaults to `journey`.
   */
  category?: string;

  /**
   * The conversion this journey exists to move — a defineConversion id
   * (including the built-in zero-config "revenue" conversion when seeded).
   * Boot-validated fail-closed in createHogsendClient: an id that matches
   * no registered conversion definition throws with the known-id list.
   * The lift/impact routes use it as the default definitionId when the
   * caller passes none; an explicit query param always wins. Purely a
   * readout default — it never gates enrollment, sends, or conversion
   * firing. (The inverse, descriptive pointer is ConversionMeta.scope
   * .journeyId — the two are independent.)
   */
  goal?: string;

  /**
   * Minimum gap between sends WITHIN this journey, per recipient email —
   * enforced at send time in the engine-owned tracked mailer. If a non-failed
   * `email_sends` row for this journey (across ALL of the journey's
   * enrollments) to the same recipient already exists inside the window, the
   * send is SKIPPED: it returns `{ status: "skipped", reason:
   * "journey_suppressed" }`, writes NO `email_sends` row, and makes NO provider
   * call — the journey run continues. A zero duration (`{}` / `hours(0)`)
   * DISABLES the guard. Only journey-bound sends are affected; transactional /
   * non-journey sends (`POST /v1/emails`, password-reset) are never suppressed.
   */
  suppress: DurationObject;

  /**
   * Per-journey holdout — the causal
   * instrument. `percent` (0–50) of would-have-entered contacts are diverted
   * at the enrollment guard chain's END (after every other guard, so a
   * contact blocked by entry limits/preferences is never counted as held
   * out — intent-to-treat hygiene). Assignment is a DETERMINISTIC hash of
   * (userId, journeyId, salt) — never RNG (replay law) — so a held-out
   * contact stays held out for this journey until `salt` changes. Diverted
   * contacts get ONE `journey_states` row with status `held_out` plus a
   * `journey.heldout` event on the spine (the counterfactual as data).
   */
  holdout?: {
    percent: number;
    /** Rotating this re-buckets the population. Default: the journey id. */
    salt?: string;
  };

  /**
   * Optional human-readable version label (e.g. "v2-shorter-copy"). Stamped
   * verbatim onto every enrollment AND holdout row this definition creates
   * (journey_states.journey_version_label). DISPLAY-ONLY: readouts group
   * cohorts by versionHash (content truth); changing only this label never
   * forks a cohort. Free text, 1–64 chars. An out-of-bounds label first
   * fails inside JourneyRegistry.register's schema parse at container boot
   * (deploy fails loudly) — intended typo-catcher behavior.
   */
  version?: string;

  /**
   * Engine-computed content fingerprint: first 12 hex chars of sha256 over
   * the normalized run source + the behavior-bearing meta fields (see
   * computeJourneyVersionHash). Set by defineJourney for code journeys and
   * blueprintMetaFromRow for blueprints — NEVER authored; any input value
   * is overwritten. Optional only so hand-built test metas stay valid.
   */
  versionHash?: string;

  // Bucket-reaction tagging (set by buildBucketReaction). Generated reactions
  // carry these so the worker's dwell-cron lookup and Studio bucket-detail
  // grouping can discover owned reactions by sourceBucketId.
  sourceBucketId?: string;
  reactionKind?: "enter" | "leave" | "dwell";
  dwellSchedule?: { label: string; after?: number; every?: number };
}

export interface JourneyUser {
  id: string;
  email: string;
  properties: Record<string, string | number | boolean | null>;
  stateId: string;
  journeyId: string;
  journeyName: string;
}
