import type {
  BrandTemplatePaletteKey,
  BrandTemplatePresetKey,
} from "./presets";

export type BrandContentLayout = "editorial" | "code" | "steps" | "cta";
export type BrandCarouselPlatform = "meta" | "reddit" | "linkedin";
export type BrandCarouselCardRole =
  | "problem"
  | "action"
  | "hogsend"
  | "get-started";

export type BrandTemplateContent = {
  eyebrow: string;
  headline: string;
  body: string;
  layout: BrandContentLayout;
  command?: string;
  steps?: readonly string[];
  sequence?: string;
  signature: "hogsend.com";
};

export type BrandTextExample = {
  preset: BrandTemplatePresetKey;
  palette: BrandTemplatePaletteKey;
  content: BrandTemplateContent;
};

export type BrandCarouselCard = BrandTemplateContent & {
  role: BrandCarouselCardRole;
};

type BrandCarouselCardTuple = readonly [
  BrandCarouselCard,
  BrandCarouselCard,
  BrandCarouselCard,
  BrandCarouselCard,
];

export type BrandCarouselVariant = {
  palette: BrandTemplatePaletteKey;
  cards: BrandCarouselCardTuple;
};

type CarouselCopy = readonly [
  readonly [headline: string, body: string],
  readonly [headline: string, body: string],
  readonly [headline: string, body: string],
  readonly [headline: string, body: string],
];

const CREATE_COMMAND = "pnpm dlx create-hogsend@latest";
const CARD_ROLES = [
  "problem",
  "action",
  "hogsend",
  "get-started",
] as const satisfies readonly BrandCarouselCardRole[];
const CARD_LAYOUTS = ["editorial", "steps", "code", "cta"] as const;

function defineCarouselCards(
  platform: BrandCarouselPlatform,
  topic: string,
  copy: CarouselCopy,
): BrandCarouselCardTuple {
  const eyebrow = `${platform.toUpperCase()} · ${topic.toUpperCase()}`;
  const defineCard = (index: 0 | 1 | 2 | 3): BrandCarouselCard => ({
    role: CARD_ROLES[index],
    eyebrow,
    headline: copy[index][0],
    body: copy[index][1],
    layout: CARD_LAYOUTS[index],
    sequence: `${String(index + 1).padStart(2, "0")} / 04`,
    signature: "hogsend.com",
    ...(index === 3 ? { command: CREATE_COMMAND } : {}),
  });

  return [defineCard(0), defineCard(1), defineCard(2), defineCard(3)];
}

export const BRAND_TEXT_EXAMPLES = {
  "og-product-logic": {
    preset: "og",
    palette: "default",
    content: {
      eyebrow: "KEEP MORE CUSTOMERS",
      headline: "Turn more signups into customers who stay.",
      body: "Automate the right follow-up based on what each customer does.",
      layout: "editorial",
      signature: "hogsend.com",
    },
  },
  "youtube-lifecycle-automation": {
    preset: "youtube-thumbnail",
    palette: "ember",
    content: {
      eyebrow: "SMARTER FOLLOW-UP",
      headline: "Build follow-up that keeps customers moving.",
      body: "Welcome new users, nudge stalled ones, and win back the people who leave.",
      layout: "code",
      command: CREATE_COMMAND,
      signature: "hogsend.com",
    },
  },
  "linkedin-measure-keep-grow": {
    preset: "linkedin-post",
    palette: "violet",
    content: {
      eyebrow: "THE GROWTH ORDER",
      headline: "See what works. Keep more customers. Then grow.",
      body: "More traffic works better when more customers stay.",
      layout: "steps",
      steps: [
        "See where people drop off",
        "Fix the follow-up",
        "Scale what keeps them",
      ],
      signature: "hogsend.com",
    },
  },
  "square-typed-tested-shipped": {
    preset: "social-square",
    palette: "cyan",
    content: {
      eyebrow: "RIGHT MESSAGE. RIGHT TIME.",
      headline: "The right message. At the right moment. Automatically.",
      body: "Turn customer actions into welcome messages, reminders, and win-back.",
      layout: "editorial",
      signature: "hogsend.com",
    },
  },
  "portrait-signup-to-retention": {
    preset: "social-portrait",
    palette: "acid",
    content: {
      eyebrow: "FROM SIGNUP TO LOYALTY",
      headline: "From new signup to repeat customer.",
      body: "Follow up when interest is high, usage drops, or it is time to come back.",
      layout: "steps",
      steps: ["Welcome them", "Keep them moving", "Win them back"],
      signature: "hogsend.com",
    },
  },
  "stream-building-live": {
    preset: "stream-screen",
    palette: "default",
    content: {
      eyebrow: "BUILDING LIVE",
      headline: "Building smarter customer follow-up live.",
      body: "From first signup to long-term customer.",
      layout: "cta",
      command: CREATE_COMMAND,
      signature: "hogsend.com",
    },
  },
} as const satisfies Record<string, BrandTextExample>;

export const BRAND_CAROUSEL_CAMPAIGNS = {
  meta: {
    "leaking-bucket": {
      palette: "ember",
      cards: defineCarouselCards("meta", "retention", [
        [
          "Paying for more signups while customers keep leaving?",
          "More traffic will not fix the customers you already lose.",
        ],
        [
          "Fix retention before you scale.",
          "Find the first drop-off, improve the follow-up, then grow what keeps people.",
        ],
        [
          "Follow up at the moment it matters.",
          "Hogsend welcomes new customers, nudges stalled users, and brings inactive people back automatically.",
        ],
        [
          "Keep more of the customers you win.",
          "Start one automated follow-up today.",
        ],
      ]),
    },
    "after-signup": {
      palette: "violet",
      cards: defineCarouselCards("meta", "after signup", [
        [
          "What happens after someone signs up?",
          "If you cannot answer that clearly, more traffic only creates more missed opportunities.",
        ],
        [
          "Find the first win.",
          "See what successful customers do early, then help everyone reach that moment sooner.",
        ],
        [
          "Respond while interest is high.",
          "Hogsend changes the next message based on what each customer does—or does not do.",
        ],
        [
          "Start with one welcome follow-up.",
          "Help more new signups reach their first win today.",
        ],
      ]),
    },
    "launch-spike": {
      palette: "cyan",
      cards: defineCarouselCards("meta", "launch follow-up", [
        [
          "Big launch. Big spike. Then everyone disappears?",
          "Another campaign only refills the same leaky bucket.",
        ],
        [
          "Help new customers stay.",
          "Make the first experience clearer, follow up when people stall, and learn why they leave.",
        ],
        [
          "Make follow-up part of the customer experience.",
          "Hogsend turns real customer activity into timely messages that keep people moving.",
        ],
        [
          "Make the next signup worth more.",
          "Start your first automated follow-up today.",
        ],
      ]),
    },
  },
  reddit: {
    "one-person-silo": {
      palette: "ember",
      cards: defineCarouselCards("reddit", "team follow-up", [
        [
          "Does all your customer follow-up live in one person’s browser?",
          "One login. No clear record. Revenue depending on one person.",
        ],
        [
          "Make every follow-up visible.",
          "Keep the messages, rules, and changes where the whole team can review them.",
        ],
        [
          "Let Hogsend run the hard parts.",
          "It remembers every wait, checks every rule, avoids unwanted sends, tracks results, and keeps working if you change email tools.",
        ],
        [
          "See it. Improve it. Send it.",
          "Start one automated follow-up today.",
        ],
      ]),
    },
    "silent-drift": {
      palette: "violet",
      cards: defineCarouselCards("reddit", "reliable follow-up", [
        [
          "Ever had an important follow-up quietly stop sending?",
          "Three names for the same signup can break a campaign without anyone noticing.",
        ],
        [
          "Use one name for each customer action.",
          "Your product and your marketing should use the same clear labels.",
        ],
        [
          "Catch mistakes before customers do.",
          "Hogsend flags broken rules before they turn into missed messages.",
        ],
        [
          "Replace guesswork with a clear fix.",
          "Put one important follow-up under team review today.",
        ],
      ]),
    },
    "clock-speed": {
      palette: "acid",
      cards: defineCarouselCards("reddit", "faster follow-up", [
        [
          "Your product changes every week. Can your customer follow-up keep up?",
          "Every update changes what customers need and when they need it.",
        ],
        [
          "Update marketing as fast as the product.",
          "Make messages easy to review, test, change, and undo.",
        ],
        [
          "Keep the team in sync.",
          "Hogsend keeps the rules together while everyone can see what is running and how it performs.",
        ],
        [
          "Move customer follow-up up to product speed.",
          "Start with one automated follow-up today.",
        ],
      ]),
    },
  },
  linkedin: {
    "shipping-not-launching": {
      palette: "ember",
      cards: defineCarouselCards("linkedin", "product launch", [
        [
          "Your team merged the feature. Did the right users find out?",
          "Finishing the product is not the same as getting people to use it.",
        ],
        [
          "Start with the people who need it most.",
          "Tell affected customers first, then relevant users, then the wider market.",
        ],
        [
          "Make every announcement more relevant.",
          "Hogsend uses customer activity to choose who gets each message and when.",
        ],
        [
          "Make customer communication part of every launch.",
          "Start one automated launch follow-up today.",
        ],
      ]),
    },
    "owner-bottleneck": {
      palette: "violet",
      cards: defineCarouselCards("linkedin", "team marketing", [
        [
          "Can only one person change your customer follow-up?",
          "Every new message and rule waits in the same person’s queue.",
        ],
        [
          "Make retention marketing a team job.",
          "Let product, marketing, and support review the moments they understand best.",
        ],
        [
          "Give everyone visibility without losing control.",
          "Hogsend runs the approved rules while the team tracks every send and result.",
        ],
        [
          "Remove the bottleneck.",
          "Move one important follow-up into Hogsend today.",
        ],
      ]),
    },
    "launch-pipeline": {
      palette: "cyan",
      cards: defineCarouselCards("linkedin", "launch campaign", [
        [
          "A launch is more than one public post.",
          "Your broadest announcement is often the least relevant.",
        ],
        [
          "Build the audience before launch day.",
          "Start with people who hit the problem, then related customers, then everyone else.",
        ],
        [
          "Turn customer activity into a launch list.",
          "Hogsend finds the right people, sends the follow-up, and tracks what they do next.",
        ],
        [
          "Make every launch repeatable.",
          "Start one automated launch campaign today.",
        ],
      ]),
    },
  },
} as const satisfies Record<
  BrandCarouselPlatform,
  Record<string, BrandCarouselVariant>
>;

export type BrandTextExampleKey = keyof typeof BRAND_TEXT_EXAMPLES;
export type BrandCarouselVariantKey<
  TPlatform extends BrandCarouselPlatform = BrandCarouselPlatform,
> = TPlatform extends BrandCarouselPlatform
  ? keyof (typeof BRAND_CAROUSEL_CAMPAIGNS)[TPlatform] & string
  : never;
export type BrandCarouselCardNumber = 1 | 2 | 3 | 4;

export type BrandTextExampleJob = BrandTextExample & {
  kind: "example";
  id: `example:${BrandTextExampleKey}`;
  example: BrandTextExampleKey;
};

export type BrandCarouselJob = {
  kind: "campaign";
  id: `campaign:${BrandCarouselPlatform}:${string}:${BrandCarouselCardNumber}`;
  platform: BrandCarouselPlatform;
  variant: string;
  card: BrandCarouselCardNumber;
  role: BrandCarouselCardRole;
  preset: "social-square";
  palette: BrandTemplatePaletteKey;
  content: BrandTemplateContent;
};

export type BrandContentJob = BrandTextExampleJob | BrandCarouselJob;

export function resolveBrandTextExample(
  id: string,
): BrandTextExample | undefined {
  if (!Object.hasOwn(BRAND_TEXT_EXAMPLES, id)) {
    return undefined;
  }

  return BRAND_TEXT_EXAMPLES[id as BrandTextExampleKey];
}

export function resolveBrandCarouselCard(
  platform: string,
  variant: string,
  card: number,
): BrandCarouselJob | undefined {
  if (
    !Object.hasOwn(BRAND_CAROUSEL_CAMPAIGNS, platform) ||
    !Number.isInteger(card) ||
    card < 1 ||
    card > 4
  ) {
    return undefined;
  }

  const platformCampaigns = BRAND_CAROUSEL_CAMPAIGNS[
    platform as BrandCarouselPlatform
  ] as Record<string, BrandCarouselVariant>;
  if (!Object.hasOwn(platformCampaigns, variant)) {
    return undefined;
  }

  const campaign = platformCampaigns[variant];
  if (!campaign) return undefined;

  const cardNumber = card as BrandCarouselCardNumber;
  const selectedCard = campaign.cards[cardNumber - 1];
  if (!selectedCard) return undefined;
  const { role, ...content } = selectedCard;

  return {
    kind: "campaign",
    id: `campaign:${platform as BrandCarouselPlatform}:${variant}:${cardNumber}`,
    platform: platform as BrandCarouselPlatform,
    variant,
    card: cardNumber,
    role,
    preset: "social-square",
    palette: campaign.palette,
    content,
  };
}

export function getBrandContentJobs(): BrandContentJob[] {
  const jobs: BrandContentJob[] = Object.entries(BRAND_TEXT_EXAMPLES).map(
    ([example, definition]) => ({
      kind: "example",
      id: `example:${example as BrandTextExampleKey}`,
      example: example as BrandTextExampleKey,
      ...definition,
    }),
  );

  for (const [platform, campaigns] of Object.entries(
    BRAND_CAROUSEL_CAMPAIGNS,
  )) {
    for (const [variant, campaign] of Object.entries(campaigns)) {
      for (let card = 1; card <= campaign.cards.length; card += 1) {
        const resolved = resolveBrandCarouselCard(platform, variant, card);
        if (resolved) {
          jobs.push(resolved);
        }
      }
    }
  }

  return jobs;
}
