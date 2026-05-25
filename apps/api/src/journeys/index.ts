import { JourneyRegistry } from "@hogsend/core/registry";
import { activationNudgeSeries } from "./activation-nudge-series.js";
import { activationWelcome } from "./activation-welcome.js";
import { churnPrevention } from "./churn-prevention.js";
import { conversionAbandonedCheckout } from "./conversion-abandoned-checkout.js";
import { conversionTrialUpgrade } from "./conversion-trial-upgrade.js";
import type { DefinedJourney } from "./define-journey.js";
import { feedbackNps } from "./feedback-nps.js";
import { reactivationDormancy } from "./reactivation-dormancy.js";
import { referralInvite } from "./referral-invite.js";
import { setJourneyRegistry } from "./registry-singleton.js";
import { retentionMilestone } from "./retention-milestone.js";
import { testOnboarding } from "./test-onboarding.js";

const allJourneys: DefinedJourney[] = [
  activationWelcome,
  activationNudgeSeries,
  conversionTrialUpgrade,
  conversionAbandonedCheckout,
  retentionMilestone,
  referralInvite,
  feedbackNps,
  reactivationDormancy,
  churnPrevention,
  testOnboarding,
];

function parseEnabledFilter(value?: string): Set<string> | "*" {
  if (!value || value.trim() === "*") return "*";
  return new Set(
    value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function createJourneyRegistry(enabledFilter?: string): JourneyRegistry {
  const registry = new JourneyRegistry();
  const enabled = parseEnabledFilter(enabledFilter);

  for (const journey of allJourneys) {
    if (enabled === "*" || enabled.has(journey.meta.id)) {
      registry.register(journey.meta);
    }
  }

  setJourneyRegistry(registry);
  return registry;
}

export function getJourneyTasks(enabledFilter?: string) {
  const enabled = parseEnabledFilter(enabledFilter);
  return allJourneys
    .filter((j) => enabled === "*" || enabled.has(j.meta.id))
    .map((j) => j.task);
}
