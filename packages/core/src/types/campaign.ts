import type { DurationObject } from "../duration.js";
import type { ConditionEval } from "./conditions.js";

/**
 * Campaign steps — the stored data form of a multi-step campaign (waves).
 * Steps are DATA executed as set operations over the audience, never
 * per-recipient code: a wave resolves qualifiers by SQL and delivers in
 * chunks. Authored via the engine's `step.send()`/`step.wait()` sugar (which
 * normalizes `where` builders to `ConditionEval[]` at definition time), so
 * everything here is plain, introspectable JSON.
 */

/**
 * A per-recipient email wave. `template` is a template-registry key (typed as
 * `TemplateName` at the authoring surface; core stores the plain string).
 * `where` filters the campaign's cohort — engagement conditions with an
 * absent `templateKey` scope to "any prior send of THIS campaign".
 */
export interface CampaignSendStep {
  kind: "send";
  template: string;
  props?: Record<string, unknown>;
  subject?: string;
  from?: string;
  where?: ConditionEval[];
}

/** A durable gap between waves (campaign status `waiting` while it elapses). */
export interface CampaignWaitStep {
  kind: "wait";
  duration: DurationObject;
}

export type CampaignStep = CampaignSendStep | CampaignWaitStep;

/**
 * The versioned `campaigns.steps` jsonb blob. `v` is the forward-evolution
 * seam (A/B splits etc.); NULL on the row means a legacy single-send
 * campaign.
 */
export interface CampaignStepsBlob {
  v: 1;
  steps: CampaignStep[];
}
