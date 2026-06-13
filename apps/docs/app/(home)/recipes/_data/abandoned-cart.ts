import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const abandonedCart = defineJourney({
  meta: {
    id: "abandoned-cart",
    name: "E-commerce — abandoned cart",
    enabled: true,
    trigger: {
      event: Events.CHECKOUT_STARTED,
      // carts under $25 never enter the journey at all
      where: (b) => b.prop("cart_value").gte(25),
    },
    entryLimit: "once_per_period",
    entryPeriod: days(7),
    suppress: hours(12),
    exitOn: [{ event: Events.CHECKOUT_COMPLETED }],
  },

  run: async (user, ctx) => {
    // Give the purchase four hours to complete on its own.
    const first = await ctx.waitForEvent({
      event: Events.CHECKOUT_COMPLETED,
      timeout: hours(4),
    });
    if (!first.timedOut) return; // they bought — nothing to recover

    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ECOMMERCE_CART_REMINDER,
      subject: "You left items in your cart",
      journeyName: user.journeyName,
      props: {
        cartId: String(user.properties.cart_id ?? ""),
        cartValue: Number(user.properties.cart_value ?? 0),
      },
    });

    // One more day. exitOn still covers a purchase mid-wait.
    const second = await ctx.waitForEvent({
      event: Events.CHECKOUT_COMPLETED,
      timeout: days(1),
    });
    if (!second.timedOut) return;

    // Land the last call at 09:30 in the shopper's own timezone.
    await ctx.sleepUntil(ctx.when.nextLocal("09:30"));
    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ECOMMERCE_CART_LAST_CALL,
      subject: "Your cart is about to expire",
      journeyName: user.journeyName,
      props: {
        cartId: String(user.properties.cart_id ?? ""),
        cartValue: Number(user.properties.cart_value ?? 0),
      },
    });
  },
});`;

const TRIGGER_CODE = `// your store server — two events drive the whole flow
await hs.events.send({
  name: "checkout.started",
  email: customer.email,
  userId: customer.id,
  eventProperties: {
    cart_id: cart.id,
    cart_value: cart.subtotal,
    item_count: cart.items.length,
  },
  idempotencyKey: \`checkout-started-\${cart.id}\`,
});

// order placed — exits the journey and resolves both waits
await hs.events.send({
  name: "checkout.completed",
  userId: customer.id,
  eventProperties: { cart_id: cart.id, order_id: order.id, revenue: order.total },
  idempotencyKey: \`checkout-completed-\${order.id}\`,
});`;

export const abandonedCart: RecipeLander = {
  slug: "abandoned-cart",
  category: "ecommerce",
  title: "Abandoned cart recovery",
  metaDescription:
    "An abandoned-cart journey in TypeScript: wait for checkout.completed, send two reminders, exit the instant the order lands. Durable waits, entry conditions, and timezone-aware last calls.",
  cardDescription:
    "Wait for the purchase, remind twice, and stop the instant the order lands.",
  eyebrow: "Recipe — E-commerce",
  subhead:
    "One durable function races the purchase: two reminders at most, zero sends after checkout.completed, and the last call lands at 09:30 in the shopper's timezone.",
  problem: {
    label: "The abandoned-cart problem",
    statement:
      "Most cart recovery runs on a scheduler: a cron sweeps for stale carts, queries who already purchased, and hopes the unsubscribe list was joined correctly. Every step is a place to double-send — the purchase that lands between the query and the send, the retry that enrolls the same cart twice, the reminder that fires at 3am local time.",
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "The whole race is one file",
    subtitle:
      "Trigger conditions, both waits, both sends, and the exit rule live in a single defineJourney() — no cron, no stale-cart query.",
    note: "Both waits and the morning sleep are durable Hatchet primitives — the run survives deploys and restarts mid-race, and a checkout.completed at any point ends it via exitOn with no further sends.",
  },
  code: [
    {
      filename: "src/journeys/abandoned-cart.ts",
      code: JOURNEY_CODE,
      caption:
        "waitForEvent is the branch (did they buy yet?); exitOn is the guarantee (a purchase at any point kills the run, even mid-sleep).",
    },
    {
      filename: "your store server",
      code: TRIGGER_CODE,
      caption:
        "Two idempotent events from your backend drive everything — a replayed call returns { stored: false } instead of re-triggering.",
    },
  ],
  points: [
    {
      title: "No abandonment detector to build",
      body: 'Abandonment is just a timeout: ctx.waitForEvent({ event: "checkout.completed", timeout: hours(4) }) resolves the moment they buy or when the window closes — no cron sweeping for stale carts.',
    },
    {
      title: "exitOn ends the run mid-anything",
      body: "A purchase during the second wait or the morning sleep exits the journey before the next send fires. The race condition that plagues scheduler-based recovery — buy at 8:59, reminder at 9:00 — structurally can't happen.",
    },
    {
      title: "Entry conditions do the audience math",
      body: 'trigger.where keeps sub-$25 carts out entirely, entryLimit: "once_per_period" caps a serial abandoner at one sequence a week, and suppress absorbs duplicate trigger events.',
    },
    {
      title: "Preferences and tracking come built in",
      body: "Every send flows through the tracked mailer: unsubscribed shoppers are skipped at send time, and every link click loops back as an email.link_clicked event you can join to checkout.completed for recovery attribution.",
    },
  ],
  faq: [
    {
      q: "Do I need a cron job to detect abandoned carts?",
      a: "No. The journey starts on checkout.started and waits for checkout.completed with a timeout. If the order arrives, the wait resolves and the run ends; if it doesn't, the timeout is the abandonment signal. There is nothing to sweep.",
    },
    {
      q: "What happens if the shopper buys while a reminder is queued?",
      a: "checkout.completed is in meta.exitOn, so the event exits the journey immediately — including during a wait or the morning sleep — and no further sends fire. The waits also resolve with timedOut: false, so the code path returns early as well.",
    },
    {
      q: "How does cart data get into the emails?",
      a: "The trigger event's scalar properties (cart_id, cart_value) ride in on user.properties, and the journey passes them as typed template props. The template's props are type-checked against your React Email registry at build time.",
    },
    {
      q: "What stops the same person being chased every day?",
      a: 'entryLimit: "once_per_period" with entryPeriod: days(7) allows one recovery sequence per week regardless of how many carts they abandon, and suppress: hours(12) absorbs duplicate trigger events inside a run.',
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/abandoned-cart",
    },
    {
      label: "Journeys guide — every ctx primitive",
      href: "/docs/guides/journeys",
    },
    {
      label: "Events & contacts — idempotency model",
      href: "/docs/recipes/events-and-contacts",
    },
  ],
  related: ["post-purchase-series", "review-request", "back-in-stock"],
};
