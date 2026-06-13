import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const postPurchaseSeries = defineJourney({
  meta: {
    id: "post-purchase-series",
    name: "E-commerce — post-purchase series",
    enabled: true,
    trigger: { event: Events.ORDER_COMPLETED },
    entryLimit: "once_per_period",
    entryPeriod: days(14),
    suppress: hours(12),
    // a return cancels the arc — even mid-wait
    exitOn: [{ event: Events.ORDER_REFUNDED }],
  },

  run: async (user, ctx) => {
    const orderId = String(user.properties.order_id ?? "");
    const productName = String(user.properties.product_name ?? "your order");

    // Day 0 — the receipt is the arc's first touch.
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ECOMMERCE_RECEIPT,
      subject: \`Order confirmed — \${productName}\`,
      journeyName: user.journeyName,
      props: { orderId, productName },
    });

    // Wait for the carrier to report delivery; ten days is the proxy
    // window when no signal ever arrives.
    const delivery = await ctx.waitForEvent({
      event: Events.DELIVERY_CONFIRMED,
      timeout: days(10),
    });

    if (delivery.timedOut) {
      // No carrier feed, or a lost webhook. Assume delivered so the rest
      // of the purchase stream keys off one event name.
      await ctx.trigger({
        event: Events.DELIVERY_CONFIRMED,
        userId: user.id,
        properties: {
          order_id: orderId,
          product_name: productName,
          source: "assumed",
        },
      });
    }

    if (!(await ctx.guard.isSubscribed())) return;

    // The product is in their hands — help them get value from it.
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ECOMMERCE_PRODUCT_ONBOARDING,
      subject: \`Getting the most from \${productName}\`,
      journeyName: user.journeyName,
      props: { orderId, productName },
    });
  },
});`;

const TRIGGER_CODE = `// your order pipeline
await hs.events.send({
  name: "order.completed",
  email: customer.email,
  userId: customer.id,
  eventProperties: {
    order_id: order.id,
    product_name: order.items[0].name,
    revenue: order.total,
  },
  idempotencyKey: \`order-completed-\${order.id}\`,
});

// your carrier/3PL webhook handler
await hs.events.send({
  name: "delivery.confirmed",
  userId: order.customerId,
  eventProperties: {
    order_id: order.id,
    product_name: order.items[0].name,
    source: "carrier",
  },
  idempotencyKey: \`delivery-\${order.id}\`,
});`;

export const postPurchaseSeries: RecipeLander = {
  slug: "post-purchase-series",
  category: "ecommerce",
  title: "Post-purchase series",
  metaDescription:
    "A post-purchase journey in TypeScript: receipt at order.completed, a durable wait for delivery.confirmed with an assumed-delivery fallback, a product-onboarding send, and an event hand-off to the review ask.",
  cardDescription:
    "Receipt, a durable wait for delivery, product onboarding, and a hand-off to the review ask.",
  eyebrow: "Recipe — E-commerce",
  subhead:
    "One durable function spans the delivery window: a receipt on order.completed, an onboarding send the moment delivery.confirmed lands (or a ten-day assumed-delivery fallback), and a refund cancels everything mid-wait.",
  problem: {
    label: "The post-purchase problem",
    statement:
      "Post-purchase sequences usually run on fixed offsets: receipt now, tips email on day 5 — whether or not the package arrived. A delayed shipment gets product-onboarding advice before the box exists; a returned order keeps getting the series; and the review ask downstream is hard-coded into the same script, so changing one step means redeploying all of them.",
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "The arc keys off delivery, not a day count",
    subtitle:
      "Trigger, the receipt, the delivery wait with its fallback, the onboarding send, and the refund exit live in one defineJourney().",
    note: "delivery.confirmed is also the trigger of the review-request journey, so the hand-off is the event itself — no coupling between the two runs, and each enforces its own entryLimit and preference checks.",
  },
  code: [
    {
      filename: "src/journeys/post-purchase-series.ts",
      code: JOURNEY_CODE,
      caption:
        'waitForEvent answers "has it arrived?"; the timeout branch converts silence into the same delivery.confirmed event, tagged source: "assumed".',
    },
    {
      filename: "your fulfillment stack",
      code: TRIGGER_CODE,
      caption:
        "Two idempotent events drive the arc — a replayed delivery webhook returns { stored: false } instead of re-triggering anything.",
    },
  ],
  points: [
    {
      title: "The arc is delivery-driven, not offset-driven",
      body: 'ctx.waitForEvent({ event: "delivery.confirmed", timeout: days(10) }) resumes the instant the carrier reports — the onboarding email lands when the product does, and the durable wait survives deploys across the whole shipping window.',
    },
    {
      title: "Silence still produces one event name",
      body: 'When the wait times out, ctx.trigger fires delivery.confirmed with source: "assumed" through the full ingest pipeline. Downstream journeys and destinations key off a single event; the property records the provenance.',
    },
    {
      title: "A refund exits the run mid-anything",
      body: "order.refunded in meta.exitOn cancels the Hatchet run even during the delivery wait — no onboarding email to someone boxing up a return. The awaited delivery.confirmed is deliberately not in exitOn; an exit match mid-wait would abort the run before the send.",
    },
    {
      title: "The hand-off is an event, not a call",
      body: "The review-request journey triggers on the same delivery.confirmed event, enrolls with its own entryLimit and preference checks, and can be changed or disabled without touching this journey.",
    },
  ],
  faq: [
    {
      q: "What if my store has no carrier or delivery webhook?",
      a: 'The wait\'s ten-day timeout is the fallback: the journey fires delivery.confirmed itself with source: "assumed" and continues. With a carrier feed, the real event resolves the wait early and the assumed branch never runs.',
    },
    {
      q: "Should the receipt really live in a journey?",
      a: "It works as the arc's day-0 touch, but journey enrollment skips globally-unsubscribed contacts and entryPeriod: days(14) skips back-to-back orders. If receipts must reach everyone on every order, send them via hs.emails.send on the transactional path and keep this journey for the lifecycle arc.",
    },
    {
      q: "What happens when the same shopper orders twice in a week?",
      a: 'entryLimit: "once_per_period" with entryPeriod: days(14) admits one arc per shopper per two weeks, so two runs never overlap and stack sends. The second order\'s receipt should come from the transactional path (see above).',
    },
    {
      q: "How does the review ask connect to this journey?",
      a: 'It doesn\'t, directly. Review request declares trigger: { event: "delivery.confirmed" }, so Hatchet routes the same event to both journeys — this one resumes its wait, the review journey enrolls and runs on its own schedule.',
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/post-purchase-series",
    },
    {
      label: "Journeys guide — every ctx primitive",
      href: "/docs/guides/journeys",
    },
    {
      label: "Transactional emails — the must-deliver path",
      href: "/docs/recipes/transactional-emails",
    },
  ],
  related: ["abandoned-cart", "review-request", "back-in-stock"],
};
