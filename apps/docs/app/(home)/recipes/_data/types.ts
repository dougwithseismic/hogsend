export type RecipeCategoryId =
  | "onboarding"
  | "conversion"
  | "ecommerce"
  | "retention"
  | "scheduling"
  | "human-in-the-loop"
  | "agentic"
  | "pipelines";

export const RECIPE_CATEGORIES: Record<
  RecipeCategoryId,
  { title: string; description: string; intro: string }
> = {
  onboarding: {
    title: "Onboarding & activation",
    description:
      "Get new signups to the first moment of value — and react to whether they got there.",
    intro:
      "Onboarding recipes turn a signup into an activated user. Each one reacts to what the person actually does: it sends the next message when they hit a milestone, and nudges only the ones who stall.",
  },
  conversion: {
    title: "Trial, billing & upgrades",
    description:
      "Trial arcs, dunning, and upgrade nudges that stop the moment money arrives.",
    intro:
      "These recipes move a trial or free user to paid, and keep paying customers from lapsing. Every one stops the moment payment arrives or a card recovers, so nobody gets a nudge for something they have already done.",
  },
  ecommerce: {
    title: "E-commerce",
    description:
      "Carts, orders, deliveries, and restocks — purchase-stream flows end to end.",
    intro:
      "E-commerce recipes ride the purchase stream: cart, checkout, delivery, restock. They wait for the order to complete and only send when it does not, so a shopper never gets a 'you left something behind' after they have paid.",
  },
  retention: {
    title: "Retention & engagement",
    description:
      "Win-backs, surveys, digests, and the sunset policy that protects deliverability.",
    intro:
      "Retention recipes bring quiet users back, ask for feedback, and keep your sending list healthy. The win-back and sunset flows stop sending to people who have truly gone, which protects your domain's reputation.",
  },
  scheduling: {
    title: "Timing & scheduling",
    description:
      "Send at the right moment in each person's own timezone — reminders, anniversaries, and time-of-day windows.",
    intro:
      "Scheduling recipes land each send at the right local moment: a reminder before an event, an anniversary note, a morning-only send. The timing is computed per person from their timezone, not from a single server clock.",
  },
  "human-in-the-loop": {
    title: "Human-in-the-loop",
    description:
      "Flows that pause for a person — approvals, lead alerts, concierge touches.",
    intro:
      "These recipes pause for a person. The journey waits on an event that an operator fires — an approval, a reply, a hand-raise — so the flow only continues once a human has weighed in.",
  },
  agentic: {
    title: "Agents & AI",
    description:
      "Agents as producers and consumers of the same event stream your app uses.",
    intro:
      "Agentic recipes treat an AI agent as another producer on the same event stream your app already uses. The agent fires events and drafts content; the journey's entry conditions and typed templates keep that output safe to send.",
  },
  pipelines: {
    title: "Pipelines & orchestration",
    description:
      "Webhook sources in, destinations out, and journeys composed into funnels.",
    intro:
      "Pipeline recipes connect Hogsend to the rest of your stack: events in from PostHog or Stripe, alerts out to Slack, and journeys composed into multi-step funnels.",
  },
};

export type RecipeCodeBlock = {
  /** Shown in the code window chrome, e.g. "src/journeys/abandoned-cart.ts". */
  filename: string;
  code: string;
  caption: string;
};

export type RecipePoint = { title: string; body: string };

export type RecipeFaqItem = { q: string; a: string };

export type RecipeLink = { label: string; href: string };

export type RecipeLander = {
  /** Must match the docs page slug: /docs/recipes/<slug>. */
  slug: string;
  category: RecipeCategoryId;
  /** Hero + card title, sentence case. */
  title: string;
  /** <meta name="description">. */
  metaDescription: string;
  /** One-sentence description for index grids. */
  cardDescription: string;
  /** Hero kicker, e.g. "Recipe — E-commerce". */
  eyebrow: string;
  /** One factual sentence under the hero title. */
  subhead: string;
  /** The failure mode this recipe removes. */
  problem: { label: string; statement: string };
  walkthrough: {
    eyebrow: string;
    title: string;
    subtitle?: string;
    note?: string;
  };
  code: RecipeCodeBlock[];
  /** Exactly four engine guarantees that make the flow hold up. */
  points: RecipePoint[];
  faq: RecipeFaqItem[];
  /** Deep links rendered next to the FAQ; the docs recipe first. */
  links: RecipeLink[];
  /** Sibling recipe slugs (2–3). */
  related: string[];
};
