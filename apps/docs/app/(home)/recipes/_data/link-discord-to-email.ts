import type { RecipeLander } from "./types";

const WIRING_CODE = `// src/discord.ts — the consumer wiring that makes /link work. The same engine
// cold-connect primitive Telegram uses: /link emails a one-click confirm LINK
// (no typed code); the bind runs in the browser when the user clicks it.
import { createColdConnect, getEmailService } from "@hogsend/engine";
import { createDiscordConnector } from "@hogsend/plugin-discord";

// Built ONCE — owns the sealed-token store, the connect page, and the
// peek -> ingestEvent -> consume exchange.
export const discordColdConnect = createColdConnect({
  connectorId: "discord",
  identityKind: "discordId",      // the dedicated contacts.discord_id column
  platformKey: (id) => id,        // the RAW snowflake (no namespace prefix)
  linkedEvent: "discord.linked",  // pushed by the exchange's ingest
  identifyPropKey: "discord_id",  // set client-side in posthog.identify(contactKey)
  buildIngest: (b) => ({
    eventProperties: { source: "discord", discordId: b.platformUserId, via: "email_confirm" },
    contactProperties: { discord: { id: b.platformUserId } }, // deep-merged, never clobbers
  }),
  branding: { badge: "💬", title: "Connect your Discord" /* …logo + copy… */ },
});

export const discordConnector = createDiscordConnector({
  applicationId: env.DISCORD_APPLICATION_ID,
  clientSecret: env.DISCORD_CLIENT_SECRET,
  publicKeyHex: env.DISCORD_PUBLIC_KEY,
  redirectUri: \`\${base}/v1/connectors/discord/oauth/callback\`,
  studioIntegrationsUrl: \`\${base}/studio/integrations\`,
  saveDerived: async (patch) => {
    /* read-merge-write into the derived credential */
  },

  // discord_id is the SOLE merge key; go through client.identity.linkContact so
  // the /link merge propagates the PostHog person merge through the engine.
  resolveContact: async (p) =>
    requireIdentity().linkContact({
      discordId: p.discordId,
      email: p.email,
      contactProperties: p.contactProperties,
    }),

  // The /link front door. The anti-email-bomb throttle runs FIRST inside
  // mintConfirm (Redis-INCR, per-user + per-email, fail-closed); only on ok do
  // we email the one-click confirm LINK. The handler never sees the token.
  requestConfirm: async ({ discordUserId, email }) => {
    const minted = await discordColdConnect.mintConfirm({ platformUserId: discordUserId, email });
    if (!minted.ok) {
      return { ok: false, reason: minted.reason === "redis_unavailable" ? "unavailable" : "rate_limited" };
    }
    const url = discordColdConnect.confirmUrl({ apiPublicUrl: base, token: minted.token });
    // TRANSACTIONAL send — skipPreferenceCheck so the link is never suppressed.
    await getEmailService().send({
      template: "transactional/magic-link",
      props: { magicLinkUrl: url, expiresIn: "15 minutes" },
      to: email,
      userId: email,
      userEmail: email,
      subject: "Confirm your Discord connection",
      category: "transactional",
      skipPreferenceCheck: true,
    });
    return { ok: true };
  },
});

// Mount the connect page + exchange (routes compose as an array):
// createApp(client, { routes: [discordColdConnect.routes] });`;

const BRANCH_CODE = `// A journey that branches on whether the contact has linked an email.
// JourneyUser carries no nested discord metadata, so read the authoritative
// contacts row — the discord_id column and contacts.properties.discord.
export const reactToLinkedState = defineJourney({
  meta: {
    id: "react-to-linked-state",
    name: "Discord — react to link state",
    enabled: true,
    trigger: { event: Events.DISCORD_MESSAGE_SENT },
    entryLimit: "once_per_period",
    entryPeriod: days(7),
    suppress: hours(12),
  },

  run: async (user, ctx) => {
    const db = getDb();
    const contact = await db.query.contacts.findFirst({
      where: eq(contacts.id, user.id),
    });

    // A linked contact has an email AND a discord_id; an unlinked one is
    // discord-only. The metadata object is read-only context.
    const meta = (contact?.properties?.discord ?? {}) as {
      username?: string;
      last_seen?: string;
    };

    if (!contact?.email) {
      // Discord-only — there is no address. Nudge to link via the channel.
      await ctx.trigger({
        event: Events.DISCORD_NUDGE_LINK,
        userId: user.id,
        properties: { username: meta.username ?? null },
      });
      return;
    }

    // Linked — a real address to use.
    await sendEmail({
      to: contact.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.DISCORD_ACTIVE_THANKS,
      subject: \`Thanks for being active, \${meta.username ?? "friend"}\`,
      journeyName: user.journeyName,
    });
  },
});`;

export const linkDiscordToEmail: RecipeLander = {
  slug: "link-discord-to-email",
  category: "onboarding",
  title: "Link a Discord account to an email",
  metaDescription:
    "How the in-Discord /link flow attaches an email to a Discord account: /link opens an email modal, Hogsend emails a one-click confirm link (the same cold-connect flow Telegram uses), clicking it folds the email onto the discord_id contact, and a journey reads the resulting discord_id and contacts.properties.discord.",
  cardDescription:
    "Attach an email to a Discord account with an in-Discord /link command that emails a one-click confirm link, then branch journeys on whether a contact is linked.",
  eyebrow: "Recipe — Onboarding & activation",
  subhead:
    "/link opens an email modal, Hogsend emails a one-click confirm link, and clicking it folds the email onto the discord_id contact in the browser — after which discord_id and contacts.properties.discord are on the row.",
  problem: {
    label: "The identity-resolution problem",
    statement:
      "A Discord member and an email subscriber are the same person on two surfaces, but nothing ties them together. Without a link step, a discord_id contact can never be emailed, an email contact never gets credit for Discord activity, and any attempt to match on the OAuth-reported Discord email is a grafting vector — it lets a member attach an address they do not control.",
  },
  walkthrough: {
    eyebrow: "The loop",
    title: "An email modal, an emailed link, a one-click attach",
    subtitle:
      "/link collects the email in a modal, the connector mints a sealed cold-connect token and emails a one-click confirm link, and the connect page folds discord_id + email onto one contact only on an explicit button click — resolving through the discord identity Kind so discord_id stays the sole merge key.",
    note: "The authoritative email is the one typed into /link (and the one the link was issued for), never the OAuth-reported Discord email. The token seals { discordId, email } server-side and is single-use; the bind runs on POST, never GET, so an email link-preview prefetch can't complete it.",
  },
  code: [
    {
      filename: "src/discord.ts",
      code: WIRING_CODE,
      caption:
        "The same engine cold-connect primitive Telegram uses: discordColdConnect (createColdConnect) owns the connect page + the peek -> ingest -> consume exchange, and the connector's requestConfirm callback mints a sealed token (throttled, fail-closed) and emails the one-click confirm link through a transactional send.",
    },
    {
      filename: "src/journeys/react-to-linked-state.ts",
      code: BRANCH_CODE,
      caption:
        "JourneyUser has no nested Discord metadata — read the contacts row: contact.email tells you linked vs Discord-only, and contacts.properties.discord is the read-only metadata.",
    },
  ],
  points: [
    {
      title: "The bind is proven by the click, not the typed address",
      body: "The confirm token seals { discordId, email } server-side and the /connect/discord page only completes the bind on an explicit Confirm connection button (a POST to /connect/discord/exchange) — so a forged /link can never attach an address the sender does not control, and an email link-preview prefetch (a GET) can't finish it.",
    },
    {
      title: "The confirm link rides a transactional send",
      body: 'getEmailService().send uses category: "transactional" with skipPreferenceCheck: true, so the confirmation link is never dropped by an unsubscribe or a frequency cap. The token is single-use and TTL-bound, consumed only after the bind ingest commits, so a transient failure still leaves a working retry.',
    },
    {
      title: "The throttle runs inside mintConfirm",
      body: "Before any token is sealed, mintConfirm enforces the cold-connect throttle (per Discord user and per target email, Redis-INCR rolling windows, fail-closed), so an over-cap /link returns { ok: false } with no email sent. The consumer no longer hand-rolls a verification-attempt counter.",
    },
    {
      title: "discord_id is the sole merge key",
      body: "resolveContact goes through client.identity.linkContact with the discord identity Kind, so the raw snowflake lands in the indexed discord_id column and the /link merge propagates the PostHog person merge through the engine. contacts.properties.discord is decorative metadata, deep-merged and non-clobbering — never a resolution key.",
    },
  ],
  faq: [
    {
      q: "Why an emailed link instead of a typed code?",
      a: "The /link command opens an email modal; on a valid address Hogsend emails a one-click confirm link and the bind happens in the browser when the member clicks it — there is no 6-digit code to copy back into Discord. It is the same cold-connect flow Telegram uses. Every interaction is ed25519-verified, and no message body ever echoes the email.",
    },
    {
      q: "What email gets linked — the one typed or the Discord account's email?",
      a: "The one typed into the /link modal, proven by the click on the emailed link. The OAuth member-link alternative uses the address the link was issued for, never the OAuth-reported Discord email — using the latter as a resolution key would let a member attach an address they do not own.",
    },
    {
      q: "How do I read the linked identity in a journey?",
      a: "JourneyUser carries id/email/properties but not the nested Discord metadata. Read the authoritative contacts row: the discord_id column is the merge key, contact.email tells you linked vs Discord-only, and contacts.properties.discord holds username, global_name, avatar, joined_at, roles, and the derived last_seen.",
    },
    {
      q: "Is there a web-initiated alternative to /link?",
      a: "Yes — the OAuth member-link is initiated from your app (a Connect Discord button) rather than inside Discord: the engine mints a signed member_link URL, the user authorizes on Discord, and the callback attaches discord_id to the contact the link was issued for. The in-Discord /link confirm-link flow is the primary path.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/link-discord-to-email",
    },
    {
      label: "Discord integration — the /link identity loop",
      href: "/docs/integrations/discord",
    },
    {
      label: "Email guide — transactional sends and preferences",
      href: "/docs/guides/email",
    },
  ],
  related: [
    "welcome-new-discord-members",
    "re-engage-quiet-discord-members",
    "route-a-reaction-as-a-signal",
  ],
};
