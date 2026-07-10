/**
 * Authoring sugar for campaign steps ({@link defineCampaign} `steps:`).
 * Each helper returns the plain stored POJO ({@link CampaignStep} —
 * `campaigns.steps` blob entries): `step.send` normalizes a `where` builder
 * to `ConditionEval[]` HERE, at authoring time (the same
 * normalize-at-definition pattern as `trigger.where` in `defineJourney`), so
 * the stored form is always introspectable data. Channel steps
 * (`step.discord.post` / `.dm`, …) are phase 2.
 */
import {
  type CampaignSendStep,
  type CampaignWaitStep,
  type CampaignWhere,
  type DurationObject,
  normalizeCampaignWhere,
} from "@hogsend/core";
import type { TemplateName } from "@hogsend/email";

export const step = {
  /**
   * A per-recipient email wave. `where` filters the campaign's cohort
   * (builder or declarative conditions — engagement terminals with no
   * template scope to "any prior send of this campaign"); only valid on
   * steps after the first (validated by `defineCampaign`).
   */
  send(opts: {
    template: TemplateName;
    props?: Record<string, unknown>;
    subject?: string;
    from?: string;
    where?: CampaignWhere;
  }): CampaignSendStep {
    const where = normalizeCampaignWhere(opts.where);
    return {
      kind: "send",
      template: opts.template,
      ...(opts.props !== undefined ? { props: opts.props } : {}),
      ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
      ...(opts.from !== undefined ? { from: opts.from } : {}),
      ...(where !== undefined ? { where } : {}),
    };
  },

  /** A durable gap between waves. Minimum 5 minutes (validated). */
  wait(duration: DurationObject): CampaignWaitStep {
    return { kind: "wait", duration };
  },
};
