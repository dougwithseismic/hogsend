import type { RecipeLander } from "./types";

const LINK_REQUEST_CODE = `// src/journeys/telegram-link-request.ts — fires on /link <email>.
// telegramColdConnect.mintConfirm seals { telegramUserId, email } in a single-use
// token (throttled, fail-closed) and returns it; we email the confirm link. The
// typed address is PROVEN by the click, never trusted from here.
import { hours } from "@hogsend/core";
import { defineJourney, getEmailService, sendConnectorAction } from "@hogsend/engine";
import { telegramColdConnect, TelegramEvents } from "@hogsend/plugin-telegram";

const EMAIL_RE = /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/;

export const telegramLinkRequest = defineJourney({
  meta: {
    id: "telegram-link-request",
    name: "Telegram — Link Request (/link)",
    enabled: true,
    trigger: { event: TelegramEvents.LINK_REQUESTED },
    entryLimit: "unlimited",
    suppress: hours(0),
  },

  run: async (user, _ctx) => {
    const chatId = user.properties.chatId ? String(user.properties.chatId) : null;
    const fromId = user.properties.fromId ? String(user.properties.fromId) : null;
    if (!chatId || !fromId) return;

    const reply = (text: string) =>
      sendConnectorAction({
        connectorId: "telegram",
        action: "sendMessage",
        args: { chatId, text },
      });

    const email = user.properties.email ? String(user.properties.email) : "";
    if (!email || !EMAIL_RE.test(email)) {
      await reply("To connect your email, send:\\n\\n/link you@example.com");
      return;
    }

    // mintConfirm throttles per Telegram user INSIDE the primitive (Redis-backed,
    // fail-closed) — the webhook has only a static secret token, no per-message
    // signature, so a forged /link could otherwise spray a victim's inbox.
    const minted = await telegramColdConnect.mintConfirm({
      platformUserId: fromId,
      email,
    });
    if (!minted.ok) {
      await reply("Linking is briefly unavailable or rate-limited — check your inbox or try again shortly.");
      return;
    }

    const apiPublicUrl = process.env.API_PUBLIC_URL ?? "http://localhost:3002";
    const url = telegramColdConnect.confirmUrl({ apiPublicUrl, token: minted.token });

    // TRANSACTIONAL send — skipPreferenceCheck so the link is never suppressed.
    await getEmailService().send({
      template: "transactional/magic-link",
      props: { magicLinkUrl: url, expiresIn: "15 minutes" },
      to: email,
      userId: email,
      userEmail: email,
      subject: "Confirm your Telegram connection",
      category: "transactional",
      skipPreferenceCheck: true,
    });

    await reply(\`📧 I've emailed a confirmation link to \${email}. It expires in 15 minutes.\`);
  },
});`;

const EXCHANGE_CODE = `// telegramColdConnect is built ONCE with the engine createColdConnect() primitive
// (it ships pre-built from @hogsend/plugin-telegram). The primitive owns the
// sealed-token store, the connect page, and the peek -> ingestEvent -> consume
// exchange. The bind runs on a human button CLICK (POST), never on GET — a
// link-preview prefetch can't complete it.
import { createColdConnect } from "@hogsend/engine";

export const telegramColdConnect = createColdConnect({
  connectorId: "telegram",
  identityKind: "userId",
  platformKey: (id) => \`telegram:\${id}\`, // the merge key folded with the email
  linkedEvent: "telegram.linked", // pushed by the exchange's ingest -> welcome journey
  identifyPropKey: "telegram_id", // set client-side in posthog.identify(contactKey)
  buildIngest: (b) => ({
    // Scalar trigger props the welcome journey reads off user.properties.* —
    // contactProperties never reach the Hatchet payload, so the ids ride here.
    eventProperties: {
      source: "telegram",
      chatId: b.platformUserId,
      fromId: b.platformUserId,
      via: "email_confirm",
    },
    // telegram is in DEEP_MERGE_KEYS — this merges, never clobbers.
    contactProperties: {
      telegram: { id: b.platformUserId, chat_id: b.platformUserId },
    },
  }),
  branding: { badge: "✈️", title: "Connect your Telegram" /* …copy… */ },
});

// Mount the connect page + exchange (routes compose as an array):
// createApp(client, { routes: [telegramColdConnect.routes] });`;

export const linkTelegramToEmail: RecipeLander = {
  slug: "link-telegram-to-email",
  category: "onboarding",
  title: "Link a Telegram account to an email",
  metaDescription:
    "How the /link email-confirm flow attaches an email to a Telegram account: the user sends /link you@example.com, Hogsend mails a single-use confirmation link, clicking it binds telegram:<id> to the email on one contact and identifies the PostHog person client-side. Plus the /start one-tap deep link.",
  cardDescription:
    "Attach an email to a Telegram account with a /link email-confirm flow (or a one-tap /start deep link), then read the linked contact in a journey.",
  eyebrow: "Recipe — Onboarding & activation",
  subhead:
    "/link you@example.com emails a single-use confirmation link; clicking it binds telegram:<id> to the email on one contact and identifies the PostHog person client-side — and a /start deep link does it in one tap when you already know the email.",
  problem: {
    label: "The identity-resolution problem",
    statement:
      "A Telegram user and an email subscriber are the same person on two surfaces, but nothing ties them together. Without a link step, a telegram:<id> contact can never be emailed, an email contact never gets credit for Telegram activity, and trusting the address typed into /link without proof lets anyone bind a victim's email — so the bind has to be gated on inbox ownership, not on the typed string.",
  },
  walkthrough: {
    eyebrow: "The loop",
    title: "An emailed link, a button click, a verified attach",
    subtitle:
      "/link collects the email in Telegram, a journey mints a sealed token and emails the confirm link, and the connect page binds telegram:<id> to the email only on an explicit button click — then identifies the PostHog person client-side.",
    note: "The token seals { telegramUserId, email } server-side and is single-use; the web caller never names either id. The bind runs on POST, never GET, so an email or link-preview prefetch can't complete it. A /start deep link is the one-tap alternative when the email is already known.",
  },
  code: [
    {
      filename: "src/journeys/telegram-link-request.ts",
      code: LINK_REQUEST_CODE,
      caption:
        "Fires on /link <email>: validate the shape, mint a sealed confirm token via telegramColdConnect.mintConfirm (throttled + fail-closed inside the primitive), and email the link through a transactional send so it is never suppressed.",
    },
    {
      filename: "src/connectors/telegram.ts",
      code: EXCHANGE_CODE,
      caption:
        "telegramColdConnect (from createColdConnect) owns the connect page + the POST exchange: peek the sealed token, ingest telegram.linked to fold telegram:<id> + email onto one contact, then consume. Mount its routes; the page hands the returned contact key to posthog.identify client-side.",
    },
  ],
  points: [
    {
      title: "The bind is proven by the click, not the typed address",
      body: "The confirm token seals { telegramUserId, email } server-side and the /connect/telegram page only completes the bind on an explicit button POST — so a forged or replayed /link can never attach an address the sender does not actually control.",
    },
    {
      title: "The confirm link rides a transactional send",
      body: 'getEmailService().send uses category: "transactional" with skipPreferenceCheck: true, so the confirmation link is never dropped by an unsubscribe or a frequency cap. The token is single-use and TTL-bound, consumed only after the bind ingest commits, so a transient failure still leaves the user a working retry.',
    },
    {
      title: "An anti-email-bomb rate limit",
      body: "The Telegram webhook carries only a static secret-token header, not a per-message signature, so a forged /link could otherwise spray a victim's inbox from your sending domain. telegramColdConnect.mintConfirm throttles confirmation emails per Telegram user inside the primitive (Redis-backed, fail-closed).",
    },
    {
      title: "telegram:<id> is the merge key; metadata never resolves",
      body: "The bind sets userId = telegram:<id> and userEmail, so the engine folds the Telegram identity onto the email contact. contacts.properties.telegram (username, names, language, derived last_seen) is deep-merged decorative metadata — never a resolution key.",
    },
  ],
  faq: [
    {
      q: "What email gets linked — the one typed, or one Telegram reports?",
      a: "The one typed into /link, and only after the emailed confirmation link is clicked. Telegram does not expose a user's email at all; inbox ownership of the typed address is the entire proof, which is why the bind is gated on the click rather than the typed string.",
    },
    {
      q: "Why bind on a button click instead of when the link is opened?",
      a: "Email clients and Telegram prefetch link previews with a GET, which would complete a bind triggered on page load. The /connect/telegram page only binds on the explicit Confirm connection button (a POST to /connect/telegram/exchange), so a prefetch fetches the page but cannot finish the link.",
    },
    {
      q: "When should I use /start instead of /link?",
      a: "Use the one-tap /start deep link when you already know the contact's email — a logged-in dashboard. mintTelegramStartLink stores token → email in Redis (900s TTL, the binding never rides in the link) and renders a t.me/<bot>?start=<token> button; one tap emits telegram.linked with both userId and userEmail, no email round trip. Use /link for a cold connect started inside Telegram.",
    },
    {
      q: "How do I read the linked identity in a journey?",
      a: "telegram.linked sets user.email once the bind commits, so a journey on that event can branch on user.email directly. The richer contacts.properties.telegram metadata is on the contact row, deep-merged and non-clobbering; telegram:<id> (the externalId) is the merge key, never the metadata.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/link-telegram-to-email",
    },
    {
      label: "Telegram integration — the link paths and identity",
      href: "/docs/integrations/telegram",
    },
    {
      label: "Email guide — transactional sends and preferences",
      href: "/docs/guides/email",
    },
  ],
  related: ["welcome-new-telegram-members", "link-discord-to-email"],
};
