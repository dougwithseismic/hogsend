import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const reviewRequest = defineJourney({
  meta: {
    id: "review-request",
    name: "E-commerce — review request",
    enabled: true,
    trigger: { event: Events.DELIVERY_CONFIRMED },
    // one ask per shopper per month, however many orders deliver
    entryLimit: "once_per_period",
    entryPeriod: days(30),
    suppress: hours(24),
    // a refund cancels the ask. REVIEW_RATED must never appear here —
    // the journey awaits it below.
    exitOn: [{ event: Events.ORDER_REFUNDED }],
  },

  run: async (user, ctx) => {
    const orderId = String(user.properties.order_id ?? "");
    const productName = String(user.properties.product_name ?? "your order");

    // Three days of actually using the product before asking.
    await ctx.sleep({ duration: days(3) });
    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ECOMMERCE_REVIEW_REQUEST,
      subject: \`How is \${productName} working out?\`,
      journeyName: user.journeyName,
      props: { orderId, productName },
    });

    // The stars in the email are semantic links — a click fires
    // review.rated { rating }. lookback covers the send→wait gap.
    const answer = await ctx.waitForEvent({
      event: Events.REVIEW_RATED,
      timeout: days(7),
      lookback: minutes(30),
    });

    if (answer.timedOut) return; // no answer — leave them be

    const rating = Number(answer.properties?.rating ?? 0);

    if (rating <= 3) {
      // Unhappy — flag support instead of asking for a public review.
      await ctx.trigger({
        event: Events.REVIEW_NEEDS_FOLLOWUP,
        userId: user.id,
        properties: { order_id: orderId, rating, source: "review-request" },
      });
      return;
    }

    if (!(await ctx.guard.isSubscribed())) return;

    // Happy — now ask for the public review.
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ECOMMERCE_REVIEW_PUBLIC_ASK,
      subject: "Would you share that in a review?",
      journeyName: user.journeyName,
      props: { orderId, productName, rating },
    });
  },
});`;

const TEMPLATE_CODE = `// the rating row — each star is a semantic link
import { EmailAction, HOSTED_ANSWER_HREF } from "@hogsend/email";
import { Events } from "../../journeys/constants/index.js";

{[1, 2, 3, 4, 5].map((rating) => (
  <EmailAction
    key={rating}
    event={Events.REVIEW_RATED}
    properties={{ rating }}
    href={HOSTED_ANSWER_HREF}
    className="mx-1 inline-block rounded-lg border px-4 py-2"
  >
    {"★".repeat(rating)}
  </EmailAction>
))}`;

export const reviewRequest: RecipeLander = {
  slug: "review-request",
  category: "ecommerce",
  title: "Review request",
  metaDescription:
    "A review-request journey in TypeScript: five semantic-link stars inside the email, a durable wait for the rating, and a branch — public-review ask for 4–5, a support flag for 1–3, silence for no answer.",
  cardDescription:
    "Five stars in the email, a durable wait for the rating, and a branch on the score.",
  eyebrow: "Recipe — E-commerce",
  subhead:
    "The rating question lives inside the email as five semantic links; the journey reads the clicked score from ctx.waitForEvent and routes 4–5 to a public-review ask, 1–3 to a support flag, and silence to nothing.",
  problem: {
    label: "The review-ask problem",
    statement:
      "The standard review ask is a blast N days after purchase with a link to the review platform — unhappy customers get funneled to a public form, nobody intercepts the 1-star before it's published, and the survey tool that could have caught it lives in a separate system with separate identity. Click data tells you the email was opened, not what the customer thinks.",
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "The click is the form submission",
    subtitle:
      "Trigger, the three-day pause, the rating wait, and both branches live in one defineJourney() — the email and the journey share one event vocabulary.",
    note: "A star click fires review.rated { rating } through the full ingest pipeline after scanner-burst suppression; the durable wait resumes with the payload, so the branch is an if statement on a number.",
  },
  code: [
    {
      filename: "src/journeys/review-request.ts",
      code: JOURNEY_CODE,
      caption:
        "waitForEvent returns the answer's payload — rating ≤ 3 flags support via ctx.trigger and sends nothing; ≥ 4 gets the public-review ask.",
    },
    {
      filename: "src/emails/ecommerce/review-request.tsx",
      code: TEMPLATE_CODE,
      caption:
        "HOSTED_ANSWER_HREF lands the click on the engine-hosted answer page; optional free text ingests as review.rated.comment.",
    },
  ],
  points: [
    {
      title: "First answer wins, scanners lose",
      body: "All five stars share one answer slot per send — the first confirmed click counts, repeats are raw clicks only. Confirmation is deferred ~30 seconds so corporate link scanners (SafeLinks, Proofpoint) are seen as a burst and suppressed, never recorded as a 1-star rating.",
    },
    {
      title: "The branch is code on a scalar",
      body: "ctx.waitForEvent resumes with the matched event's properties, so routing is Number(answer.properties?.rating) and an if statement — no survey tool, no webhook glue, no polling a third-party API.",
    },
    {
      title: "Detractors are intercepted, not published",
      body: "A 1–3 rating fires review.needs_followup through the full ingest pipeline — a real event your ops task or alert journey reacts to — and the shopper never receives a public-review link.",
    },
    {
      title: "The ask is rate-limited by metadata",
      body: 'entryLimit: "once_per_period" with entryPeriod: days(30) caps the asks at one per shopper per month regardless of order volume, and order.refunded in exitOn cancels the ask mid-wait for returned orders.',
    },
  ],
  faq: [
    {
      q: "How does a click in an email become structured data?",
      a: "Each star is an EmailAction — the engine lifts the event name and { rating } payload into its tracked_links row at send time and strips the attributes from the HTML. At click time the redirect records a provisional answer; a deferred task confirms it past the scanner-burst window and emits it through the full ingest pipeline.",
    },
    {
      q: "What if the shopper clicks two different stars?",
      a: "First confirmed answer wins per (send, event name). A 3 followed by a 5 records the 3 for the journey's branch; the later click is stored as a raw link click but not re-emitted as an answer.",
    },
    {
      q: "Can they leave written feedback too?",
      a: "Yes — href={HOSTED_ANSWER_HREF} resolves to an engine-hosted answer page with an optional free-text box. A submitted comment ingests as review.rated.comment with the rating's properties attached, one comment per send.",
    },
    {
      q: "Why isn't review.rated in exitOn?",
      a: "Because the journey awaits it. An exit match mid-wait aborts the run before the post-wait branch executes — the rating would be recorded and then ignored. One event name, one role: react via waitForEvent or exit via exitOn, never both.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/review-request",
    },
    {
      label: "Semantic links guide — the click-to-event pipeline",
      href: "/docs/guides/semantic-links",
    },
    {
      label: "Journeys guide — waitForEvent and lookback",
      href: "/docs/guides/journeys",
    },
  ],
  related: ["post-purchase-series", "nps-survey", "support-followup"],
};
