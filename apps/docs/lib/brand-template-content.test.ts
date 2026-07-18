import { describe, expect, it } from "vitest";
import {
  BRAND_CAROUSEL_CAMPAIGNS,
  BRAND_TEXT_EXAMPLES,
  type BrandCarouselVariant,
  getBrandContentJobs,
  resolveBrandCarouselCard,
  resolveBrandTextExample,
} from "./brand-template-content";

const EXPECTED_EXAMPLES = [
  "og-product-logic",
  "youtube-lifecycle-automation",
  "linkedin-measure-keep-grow",
  "square-typed-tested-shipped",
  "portrait-signup-to-retention",
  "stream-building-live",
] as const;

const EXPECTED_VARIANTS = {
  meta: ["leaking-bucket", "after-signup", "launch-spike"],
  reddit: ["one-person-silo", "silent-drift", "clock-speed"],
  linkedin: ["shipping-not-launching", "owner-bottleneck", "launch-pipeline"],
} as const;

const EXPECTED_ROLES = ["problem", "action", "hogsend", "get-started"] as const;

const EXPECTED_HEADLINES = {
  meta: {
    "leaking-bucket": [
      "Paying for more signups while customers keep leaving?",
      "Fix retention before you scale.",
      "Follow up at the moment it matters.",
      "Keep more of the customers you win.",
    ],
    "after-signup": [
      "What happens after someone signs up?",
      "Find the first win.",
      "Respond while interest is high.",
      "Start with one welcome follow-up.",
    ],
    "launch-spike": [
      "Big launch. Big spike. Then everyone disappears?",
      "Help new customers stay.",
      "Make follow-up part of the customer experience.",
      "Make the next signup worth more.",
    ],
  },
  reddit: {
    "one-person-silo": [
      "Does all your customer follow-up live in one person’s browser?",
      "Make every follow-up visible.",
      "Let Hogsend run the hard parts.",
      "See it. Improve it. Send it.",
    ],
    "silent-drift": [
      "Ever had an important follow-up quietly stop sending?",
      "Use one name for each customer action.",
      "Catch mistakes before customers do.",
      "Replace guesswork with a clear fix.",
    ],
    "clock-speed": [
      "Your product changes every week. Can your customer follow-up keep up?",
      "Update marketing as fast as the product.",
      "Keep the team in sync.",
      "Move customer follow-up up to product speed.",
    ],
  },
  linkedin: {
    "shipping-not-launching": [
      "Your team merged the feature. Did the right users find out?",
      "Start with the people who need it most.",
      "Make every announcement more relevant.",
      "Make customer communication part of every launch.",
    ],
    "owner-bottleneck": [
      "Can only one person change your customer follow-up?",
      "Make retention marketing a team job.",
      "Give everyone visibility without losing control.",
      "Remove the bottleneck.",
    ],
    "launch-pipeline": [
      "A launch is more than one public post.",
      "Build the audience before launch day.",
      "Turn customer activity into a launch list.",
      "Make every launch repeatable.",
    ],
  },
} as const;

const EXPECTED_BODIES = {
  meta: {
    "leaking-bucket": [
      "More traffic will not fix the customers you already lose.",
      "Find the first drop-off, improve the follow-up, then grow what keeps people.",
      "Hogsend welcomes new customers, nudges stalled users, and brings inactive people back automatically.",
      "Start one automated follow-up today.",
    ],
    "after-signup": [
      "If you cannot answer that clearly, more traffic only creates more missed opportunities.",
      "See what successful customers do early, then help everyone reach that moment sooner.",
      "Hogsend changes the next message based on what each customer does—or does not do.",
      "Help more new signups reach their first win today.",
    ],
    "launch-spike": [
      "Another campaign only refills the same leaky bucket.",
      "Make the first experience clearer, follow up when people stall, and learn why they leave.",
      "Hogsend turns real customer activity into timely messages that keep people moving.",
      "Start your first automated follow-up today.",
    ],
  },
  reddit: {
    "one-person-silo": [
      "One login. No clear record. Revenue depending on one person.",
      "Keep the messages, rules, and changes where the whole team can review them.",
      "It remembers every wait, checks every rule, avoids unwanted sends, tracks results, and keeps working if you change email tools.",
      "Start one automated follow-up today.",
    ],
    "silent-drift": [
      "Three names for the same signup can break a campaign without anyone noticing.",
      "Your product and your marketing should use the same clear labels.",
      "Hogsend flags broken rules before they turn into missed messages.",
      "Put one important follow-up under team review today.",
    ],
    "clock-speed": [
      "Every update changes what customers need and when they need it.",
      "Make messages easy to review, test, change, and undo.",
      "Hogsend keeps the rules together while everyone can see what is running and how it performs.",
      "Start with one automated follow-up today.",
    ],
  },
  linkedin: {
    "shipping-not-launching": [
      "Finishing the product is not the same as getting people to use it.",
      "Tell affected customers first, then relevant users, then the wider market.",
      "Hogsend uses customer activity to choose who gets each message and when.",
      "Start one automated launch follow-up today.",
    ],
    "owner-bottleneck": [
      "Every new message and rule waits in the same person’s queue.",
      "Let product, marketing, and support review the moments they understand best.",
      "Hogsend runs the approved rules while the team tracks every send and result.",
      "Move one important follow-up into Hogsend today.",
    ],
    "launch-pipeline": [
      "Your broadest announcement is often the least relevant.",
      "Start with people who hit the problem, then related customers, then everyone else.",
      "Hogsend finds the right people, sends the follow-up, and tracks what they do next.",
      "Start one automated launch campaign today.",
    ],
  },
} as const;

const EXPECTED_PALETTES = {
  meta: {
    "leaking-bucket": "ember",
    "after-signup": "violet",
    "launch-spike": "cyan",
  },
  reddit: {
    "one-person-silo": "ember",
    "silent-drift": "violet",
    "clock-speed": "acid",
  },
  linkedin: {
    "shipping-not-launching": "ember",
    "owner-bottleneck": "violet",
    "launch-pipeline": "cyan",
  },
} as const;

describe("brand template content", () => {
  it("uses plain customer-marketing language in every visible card", () => {
    const visibleCopy = [
      ...Object.values(BRAND_TEXT_EXAMPLES).map(({ content }) => content),
      ...Object.values(BRAND_CAROUSEL_CAMPAIGNS).flatMap((campaigns) =>
        Object.values(campaigns).flatMap(({ cards }) => cards),
      ),
    ];

    for (const content of visibleCopy) {
      const words = [
        content.eyebrow,
        content.headline,
        content.body,
        ...("steps" in content ? content.steps : []),
      ].join(" ");
      expect(words).not.toMatch(
        /\b(lifecycle|compiler|typescript|runtime|suppression|authorship)\b/i,
      );
    }
  });

  it("defines the six approved standalone examples in stable order", () => {
    expect(Object.keys(BRAND_TEXT_EXAMPLES)).toEqual(EXPECTED_EXAMPLES);
    expect(BRAND_TEXT_EXAMPLES["og-product-logic"]).toMatchObject({
      preset: "og",
      palette: "default",
      content: {
        headline: "Turn more signups into customers who stay.",
        body: "Automate the right follow-up based on what each customer does.",
        layout: "editorial",
        signature: "hogsend.com",
      },
    });
    expect(BRAND_TEXT_EXAMPLES["youtube-lifecycle-automation"]).toMatchObject({
      preset: "youtube-thumbnail",
      palette: "ember",
      content: {
        headline: "Build follow-up that keeps customers moving.",
        body: "Welcome new users, nudge stalled ones, and win back the people who leave.",
        layout: "code",
        command: "pnpm dlx create-hogsend@latest",
      },
    });
    expect(BRAND_TEXT_EXAMPLES["stream-building-live"]).toMatchObject({
      preset: "stream-screen",
      palette: "default",
      content: {
        headline: "Building smarter customer follow-up live.",
        body: "From first signup to long-term customer.",
        layout: "cta",
        command: "pnpm dlx create-hogsend@latest",
      },
    });
    expect(BRAND_TEXT_EXAMPLES["linkedin-measure-keep-grow"]).toMatchObject({
      preset: "linkedin-post",
      palette: "violet",
      content: {
        headline: "See what works. Keep more customers. Then grow.",
        body: "More traffic works better when more customers stay.",
        layout: "steps",
        steps: [
          "See where people drop off",
          "Fix the follow-up",
          "Scale what keeps them",
        ],
      },
    });
    expect(BRAND_TEXT_EXAMPLES["square-typed-tested-shipped"]).toMatchObject({
      preset: "social-square",
      palette: "cyan",
      content: {
        body: "Turn customer actions into welcome messages, reminders, and win-back.",
      },
    });
    expect(BRAND_TEXT_EXAMPLES["portrait-signup-to-retention"]).toMatchObject({
      preset: "social-portrait",
      palette: "acid",
      content: {
        body: "Follow up when interest is high, usage drops, or it is time to come back.",
        steps: ["Welcome them", "Keep them moving", "Win them back"],
      },
    });
    expect(
      Object.values(BRAND_TEXT_EXAMPLES).map(
        ({ content }) => content.signature,
      ),
    ).toEqual(Array.from({ length: 6 }, () => "hogsend.com"));
    expect(
      Object.entries(BRAND_TEXT_EXAMPLES)
        .filter(([, { content }]) => "command" in content)
        .map(([id]) => id),
    ).toEqual(["youtube-lifecycle-automation", "stream-building-live"]);
  });

  it("defines three stable variants for each approved platform", () => {
    expect(Object.keys(BRAND_CAROUSEL_CAMPAIGNS)).toEqual([
      "meta",
      "reddit",
      "linkedin",
    ]);

    for (const platform of Object.keys(EXPECTED_VARIANTS) as Array<
      keyof typeof EXPECTED_VARIANTS
    >) {
      expect(Object.keys(BRAND_CAROUSEL_CAMPAIGNS[platform])).toEqual(
        EXPECTED_VARIANTS[platform],
      );

      for (const variant of EXPECTED_VARIANTS[platform]) {
        const campaign = (
          BRAND_CAROUSEL_CAMPAIGNS[platform] as Record<
            string,
            BrandCarouselVariant
          >
        )[variant];
        if (!campaign) throw new Error(`missing ${platform}/${variant}`);
        expect(campaign.cards.map(({ role }) => role)).toEqual(EXPECTED_ROLES);
        expect(campaign.cards.map(({ sequence }) => sequence)).toEqual([
          "01 / 04",
          "02 / 04",
          "03 / 04",
          "04 / 04",
        ]);
        expect(campaign.cards.map(({ headline }) => headline)).toEqual(
          (EXPECTED_HEADLINES[platform] as Record<string, readonly string[]>)[
            variant
          ],
        );
        expect(campaign.cards.map(({ body }) => body)).toEqual(
          (EXPECTED_BODIES[platform] as Record<string, readonly string[]>)[
            variant
          ],
        );
        expect(campaign.palette).toBe(
          (EXPECTED_PALETTES[platform] as Record<string, string>)[variant],
        );
        expect(
          campaign.cards.every(
            ({ body, headline, signature }) =>
              body.length > 0 &&
              headline.length > 0 &&
              signature === "hogsend.com",
          ),
        ).toBe(true);
        expect(campaign.cards[3]?.command).toBe(
          "pnpm dlx create-hogsend@latest",
        );
        expect(
          campaign.cards.slice(0, 3).every(({ command }) => !command),
        ).toBe(true);
      }
    }
  });

  it("enumerates exactly 42 unique content jobs", () => {
    const jobs = getBrandContentJobs();
    expect(jobs.filter((job) => job.kind === "example")).toHaveLength(6);
    expect(jobs.filter((job) => job.kind === "campaign")).toHaveLength(36);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(42);
    expect(jobs[0]?.id).toBe("example:og-product-logic");
    expect(jobs.at(-1)?.id).toBe("campaign:linkedin:launch-pipeline:4");
  });

  it("resolves valid content identifiers and rejects invalid ones", () => {
    expect(resolveBrandTextExample("og-product-logic")?.preset).toBe("og");
    expect(resolveBrandTextExample("missing")).toBeUndefined();

    expect(resolveBrandCarouselCard("reddit", "silent-drift", 2)).toMatchObject(
      {
        platform: "reddit",
        variant: "silent-drift",
        card: 2,
        role: "action",
        preset: "social-square",
        palette: "violet",
        content: { sequence: "02 / 04" },
      },
    );
    expect(
      resolveBrandCarouselCard("reddit", "silent-drift", 0),
    ).toBeUndefined();
    expect(
      resolveBrandCarouselCard("reddit", "silent-drift", 5),
    ).toBeUndefined();
    expect(resolveBrandCarouselCard("meta", "missing", 1)).toBeUndefined();
    for (const inheritedVariant of ["constructor", "toString", "__proto__"]) {
      expect(
        resolveBrandCarouselCard("meta", inheritedVariant, 1),
      ).toBeUndefined();
    }
    expect(
      resolveBrandCarouselCard("missing", "launch-spike", 1),
    ).toBeUndefined();
  });
});
