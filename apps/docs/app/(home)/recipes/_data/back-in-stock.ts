import type { RecipeLander } from "./types";

const SOURCE_CODE = `export const inventorySource = defineWebhookSource({
  meta: {
    id: "inventory",
    name: "Inventory",
    description: "Restock signals from the warehouse system.",
  },
  auth: {
    type: "signature", // fails closed when the secret is unset
    scheme: "hmac-hex",
    envKey: "INVENTORY_WEBHOOK_SECRET",
    header: "x-signature",
  },
  schema: restockSchema,
  async transform(payload) {
    if (payload.type !== "restock" || payload.quantity === 0) return null;

    return {
      event: Events.PRODUCT_RESTOCKED, // the routing key
      userEmail: "", // a system event — no user attached
      eventProperties: {
        sku: payload.sku,
        product_name: payload.product_name,
        quantity: payload.quantity,
        source: "inventory",
      },
      idempotencyKey: payload.delivery_id, // a redelivery is a no-op
    };
  },
});`;

const TASK_CODE = `export const restockBroadcastTask = hatchet.durableTask({
  name: "restock-broadcast",
  onEvents: [Events.PRODUCT_RESTOCKED],
  retries: 2,
  executionTimeout: "10m",
  fn: async (input: {
    properties: Record<string, string | number | boolean | null>;
  }) => {
    const sku = String(input.properties.sku ?? "");
    const productName = String(input.properties.product_name ?? "");
    if (!sku) return { status: "skipped", reason: "missing_sku" };

    // One campaign per SKU per day, however many times the task
    // retries or the warehouse re-fires.
    const date = new Date().toISOString().slice(0, 10);
    const { campaignId } = await hs.campaigns.send({
      list: \`restock-\${sku}\`,
      template: Templates.ECOMMERCE_BACK_IN_STOCK,
      props: { sku, productName },
      subject: \`\${productName} is back in stock\`,
      idempotencyKey: \`restock-\${sku}-\${date}\`,
    });

    return { status: "queued", campaignId, sku };
  },
});`;

export const backInStock: RecipeLander = {
  slug: "back-in-stock",
  category: "ecommerce",
  title: "Back-in-stock notifications",
  metaDescription:
    "Back-in-stock as code: a notify-me press subscribes the shopper to a per-product opt-in list, a signed restock webhook ingests product.restocked, and a Hatchet task broadcasts an idempotent campaign to exactly that list.",
  cardDescription:
    "Per-product opt-in lists, a signed restock webhook, and an idempotent one-shot broadcast.",
  eyebrow: "Recipe — E-commerce",
  subhead:
    "The notify-me button writes an opt-in list membership, the warehouse webhook becomes one deduplicated product.restocked event, and a small worker task broadcasts a campaign that structurally cannot double-send.",
  problem: {
    label: "The back-in-stock problem",
    statement:
      "Hand-rolled back-in-stock is a table of email addresses and a script that loops over it when inventory changes. The warehouse webhook redelivers and the script blasts twice; nobody recorded consent, so the list quietly violates it; and unsubscribes live in a different system from the loop, so removed contacts keep getting notified.",
  },
  walkthrough: {
    eyebrow: "The pipeline",
    title: "A list, a webhook source, and one idempotent broadcast",
    subtitle:
      "defineList per restock-eligible SKU, defineWebhookSource for the warehouse signal, and a durable task that fires hs.campaigns.send — three small files you own.",
    note: "Idempotency runs at two layers: the IngestEvent key dedupes redelivered webhooks before the task ever fires, and the campaign key makes the broadcast itself single-shot per SKU per day.",
  },
  code: [
    {
      filename: "src/webhook-sources/inventory.ts",
      code: SOURCE_CODE,
      caption:
        "HMAC-verified, Zod-validated, deduped by the provider's delivery id — and quantity 0 restocks are dropped at the door with return null.",
    },
    {
      filename: "src/workflows/restock-broadcast.ts",
      code: TASK_CODE,
      caption:
        "Hatchet routes the ingested event here via onEvents; the campaign idempotency key means a task retry resolves to the existing campaign instead of a second blast.",
    },
  ],
  points: [
    {
      title: "Opt-in polarity is the consent record",
      body: "Each restock list is defaultOptIn: false, so the campaign reaches only contacts with an exact true membership — the press of the notify-me button. The same ListRegistry.isSubscribed rule renders the preference center, so the broadcast and the preference UI can never disagree.",
    },
    {
      title: "Two idempotency layers, no double blast",
      body: "The webhook's delivery_id dedupes the restock signal at ingestion ({ stored: false } on redelivery); the campaign's restock-<sku>-<date> key dedupes the broadcast on task retries. Same-day inventory flapping collapses to one campaign; a restock weeks later notifies fresh.",
    },
    {
      title: "The broadcast is durable and preference-checked",
      body: "hs.campaigns.send commits a queued campaign row and enqueues the worker broadcast — a transient enqueue failure is re-enqueued by a reaper, and every recipient flows through the tracked mailer, so unsubscribed contacts land in skippedCount, not an inbox.",
    },
    {
      title: "Buyers leave the list by your own write",
      body: "The lists bag on order.completed flips the purchased SKUs' memberships to false in the same call that records the order — no separate cleanup job, and everyone else stays subscribed for the next restock.",
    },
  ],
  faq: [
    {
      q: "How do shoppers get on the list?",
      a: 'The notify-me button calls hs.events.send with lists: { "restock-<sku>": true } — the waitlist event and the opt-in in one call. hs.lists.subscribe works too if you don\'t want an event.',
    },
    {
      q: "The warehouse webhook fires twice — what happens?",
      a: "Nothing extra. The transform sets idempotencyKey to the provider's delivery id, so the second delivery is a stored: false no-op and the broadcast task never fires again. Even if the task itself retries, the campaign idempotency key resolves to the existing campaign.",
    },
    {
      q: "Does this scale to a 50,000-SKU catalog?",
      a: "Code-defined lists fit a curated set of restock-eligible products — audiences you can enumerate and review. For an unbounded long tail, keep waitlist rows in your own store database and send per-waiter transactional emails instead.",
    },
    {
      q: "Do people get notified again on every restock?",
      a: "Subscribers stay on the list until something writes false — buying the product (the order.completed lists bag) or unsubscribing via the preference center. A later restock sends a fresh campaign to whoever is still subscribed; that persistence is the intended behavior for shoppers still waiting.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/back-in-stock",
    },
    {
      label: "Lists guide — polarity and registration",
      href: "/docs/guides/lists",
    },
    {
      label: "Marketing campaigns — the broadcast guarantees",
      href: "/docs/recipes/marketing-campaigns",
    },
    {
      label: "Webhook sources — auth schemes and transforms",
      href: "/docs/guides/webhook-sources",
    },
  ],
  related: ["abandoned-cart", "post-purchase-series", "waitlist-launch"],
};
