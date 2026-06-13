import { abandonedCart } from "./abandoned-cart";
import { activationMilestones } from "./activation-milestones";
import { agentFeedbackLoop } from "./agent-feedback-loop";
import { agentTriggeredJourneys } from "./agent-triggered-journeys";
import { aiDraftedSends } from "./ai-drafted-sends";
import { anniversaryEmails } from "./anniversary-emails";
import { backInStock } from "./back-in-stock";
import { cancellationSave } from "./cancellation-save";
import { conciergeOnboarding } from "./concierge-onboarding";
import { crossJourneyFunnels } from "./cross-journey-funnels";
import { eventReminderSequence } from "./event-reminder-sequence";
import { failedPaymentDunning } from "./failed-payment-dunning";
import { humanApprovalGate } from "./human-approval-gate";
import { leadAlerts } from "./lead-alerts";
import { lifecycleAlertsInSlack } from "./lifecycle-alerts-in-slack";
import { npsSurvey } from "./nps-survey";
import { postPurchaseSeries } from "./post-purchase-series";
import { posthogTriggeredJourneys } from "./posthog-triggered-journeys";
import { reviewRequest } from "./review-request";
import { supportFollowup } from "./support-followup";
import { timezoneAwareScheduling } from "./timezone-aware-scheduling";
import { trialConversionSequence } from "./trial-conversion-sequence";
import type { RecipeCategoryId, RecipeLander } from "./types";
import { usageLimitUpgrade } from "./usage-limit-upgrade";
import { verificationChase } from "./verification-chase";
import { waitlistLaunch } from "./waitlist-launch";
import { weeklyDigest } from "./weekly-digest";
import { welcomeSeries } from "./welcome-series";
import { winbackAndSunset } from "./winback-and-sunset";

/** Catalog order: category order, then narrative order within the category. */
export const RECIPE_LANDERS: RecipeLander[] = [
  // Onboarding & activation
  welcomeSeries,
  activationMilestones,
  waitlistLaunch,
  verificationChase,
  // Trial, billing & upgrades
  trialConversionSequence,
  failedPaymentDunning,
  usageLimitUpgrade,
  cancellationSave,
  // E-commerce
  abandonedCart,
  postPurchaseSeries,
  reviewRequest,
  backInStock,
  // Retention & engagement
  winbackAndSunset,
  npsSurvey,
  weeklyDigest,
  anniversaryEmails,
  // Timing & scheduling
  timezoneAwareScheduling,
  eventReminderSequence,
  // Human-in-the-loop
  leadAlerts,
  humanApprovalGate,
  conciergeOnboarding,
  supportFollowup,
  // Agents & AI
  agentTriggeredJourneys,
  aiDraftedSends,
  agentFeedbackLoop,
  // Pipelines & orchestration
  posthogTriggeredJourneys,
  crossJourneyFunnels,
  lifecycleAlertsInSlack,
];

const BY_SLUG = new Map(RECIPE_LANDERS.map((recipe) => [recipe.slug, recipe]));

export function getRecipeLander(slug: string): RecipeLander | undefined {
  return BY_SLUG.get(slug);
}

/** Every recipe in a category, in catalog order. */
export function getRecipesByCategory(
  category: RecipeCategoryId,
): RecipeLander[] {
  return RECIPE_LANDERS.filter((recipe) => recipe.category === category);
}

/**
 * The recipe's neighbours within its own category, for in-category prev/next
 * paging. `prev`/`next` are undefined at the ends of the category list.
 */
export function getCategoryNeighbours(slug: string): {
  category: RecipeCategoryId;
  prev?: RecipeLander;
  next?: RecipeLander;
} | null {
  const recipe = BY_SLUG.get(slug);
  if (!recipe) return null;
  const siblings = getRecipesByCategory(recipe.category);
  const index = siblings.findIndex((r) => r.slug === slug);
  return {
    category: recipe.category,
    prev: index > 0 ? siblings[index - 1] : undefined,
    next: index < siblings.length - 1 ? siblings[index + 1] : undefined,
  };
}
