/**
 * Playbook category registry (the lifecycle-stage axis). Every `category` in a
 * play's frontmatter must be a key here — unknown slugs fail the build via
 * getAllPlays in lib/playbook/index.ts. `accent` is a hex used for the card
 * accent bar / category dot (inline style — not a Tailwind class).
 */
export const CATEGORIES = {
  activation: {
    label: "Activation",
    blurb: "Turn signups into users who felt the value.",
    accent: "#e5484d",
  },
  onboarding: {
    label: "Onboarding",
    blurb: "Get new users to the habit, not just the tour.",
    accent: "#f76b15",
  },
  retention: {
    label: "Retention",
    blurb: "Catch the drop before it becomes churn.",
    accent: "#ffb224",
  },
  revenue: {
    label: "Revenue & expansion",
    blurb: "Plays that move paid conversion and expansion.",
    accent: "#30a46c",
  },
  winback: {
    label: "Winback",
    blurb: "Re-open the conversation with the lapsed.",
    accent: "#0091ff",
  },
  referral: {
    label: "Referral & growth loops",
    blurb: "Let the product's users source the next users.",
    accent: "#8e4ec6",
  },
  deliverability: {
    label: "Deliverability",
    blurb: "Land in the inbox before you optimize anything else.",
    accent: "#05a2c2",
  },
  measurement: {
    label: "Measurement & attribution",
    blurb: "Prove the system moved the metric.",
    accent: "#f0f0f0",
  },
} as const;

export type CategorySlug = keyof typeof CATEGORIES;

export function isCategorySlug(slug: string): slug is CategorySlug {
  return slug in CATEGORIES;
}
