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
  { title: string; description: string }
> = {
  onboarding: {
    title: "Onboarding & activation",
    description:
      "Get new signups to the first moment of value — and react to whether they got there.",
  },
  conversion: {
    title: "Trial, billing & upgrades",
    description:
      "Trial arcs, dunning, and upgrade nudges that stop the moment money arrives.",
  },
  ecommerce: {
    title: "E-commerce",
    description:
      "Carts, orders, deliveries, and restocks — purchase-stream flows end to end.",
  },
  retention: {
    title: "Retention & engagement",
    description:
      "Win-backs, surveys, digests, and the sunset policy that protects deliverability.",
  },
  scheduling: {
    title: "Timing & scheduling",
    description:
      "Land sends at the right local moment with durable sleeps and ctx.when.",
  },
  "human-in-the-loop": {
    title: "Human-in-the-loop",
    description:
      "Flows that pause for a person — approvals, lead alerts, concierge touches.",
  },
  agentic: {
    title: "Agents & AI",
    description:
      "Agents as producers and consumers of the same event stream your app uses.",
  },
  pipelines: {
    title: "Pipelines & orchestration",
    description:
      "Webhook sources in, destinations out, and journeys composed into funnels.",
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
