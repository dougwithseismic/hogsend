import type { RecipeLander } from "./types";

const WIRING_CODE = `// src/discord.ts — the consumer wiring that makes /link work.
// createDiscordConnector injects the engine helpers the plugin must not read
// itself; the connector is then passed to createHogsendClient.
import {
  createLinkCode,
  getEmailService,
  redeemLinkCode,
  resolveOrCreateContact,
} from "@hogsend/engine";
import { createDiscordConnector } from "@hogsend/plugin-discord";

export const discordConnector = createDiscordConnector({
  applicationId: env.DISCORD_APPLICATION_ID,
  clientSecret: env.DISCORD_CLIENT_SECRET,
  publicKeyHex: env.DISCORD_PUBLIC_KEY,
  redirectUri: \`\${base}/v1/connectors/discord/oauth/callback\`,
  studioIntegrationsUrl: \`\${base}/studio/integrations\`,
  saveDerived: async (patch) => {
    /* read-merge-write into the derived credential */
  },

  // Mint a single-use code. The engine runs the anti-email-bomb throttle
  // (5/user + 3/email per 15 min) BEFORE minting; over-cap returns ok:false.
  mintCode: async ({ discordUserId, email }) => {
    const r = await createLinkCode({
      db: requireDb(),
      connectorId: "discord",
      platformUserId: discordUserId,
      email,
    });
    return r.ok ? { ok: true, code: r.code } : { ok: false, reason: "throttled" };
  },

  // TRANSACTIONAL send — skipPreferenceCheck so a verification code is NEVER
  // dropped by unsubscribe/frequency suppression.
  sendLinkCode: async ({ email, code }) => {
    await getEmailService().send({
      template: "transactional/discord-link-code",
      props: { code },
      to: email,
      userId: email,
      userEmail: email,
      subject: "Your Discord verification code",
      category: "transactional",
      skipPreferenceCheck: true,
    });
  },

  // Redeem — single-use (atomic claim), 15-min TTL, identity-bound to the
  // invoking Discord user (constant-time). On success, attach the identity.
  redeemCode: ({ discordUserId, code }) =>
    redeemLinkCode({
      db: requireDb(),
      connectorId: "discord",
      platformUserId: discordUserId,
      code,
    }),
});`;

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
    "How the in-Discord /link modal loop attaches an email to a Discord account: a transactional 6-digit code, single-use with a 15-minute TTL and rate limits, the /verify fallback, and reading the resulting discord_id and contacts.properties.discord on a contact.",
  cardDescription:
    "Attach an email to a Discord account with an in-Discord /link modal, then branch journeys on whether a contact is linked.",
  eyebrow: "Recipe — Onboarding & activation",
  subhead:
    "/link opens an email modal, Hogsend mails a single-use code via a transactional template, and /verify (or an Enter code button) folds the email onto the discord_id contact — after which discord_id and contacts.properties.discord are on the row.",
  problem: {
    label: "The identity-resolution problem",
    statement:
      "A Discord member and an email subscriber are the same person on two surfaces, but nothing ties them together. Without a link step, a discord_id contact can never be emailed, an email contact never gets credit for Discord activity, and any attempt to match on the OAuth-reported Discord email is a grafting vector — it lets a member attach an address they do not control.",
  },
  walkthrough: {
    eyebrow: "The loop",
    title: "A modal, a mailed code, a verified attach",
    subtitle:
      "/link collects the email in a modal, the engine mints and mails a single-use code through a transactional send, and the redeem path resolves the contact through the discord identity Kind — so the discord_id column stays the sole merge key.",
    note: "The authoritative email is the one the link was issued for, never the OAuth-reported Discord email. The code is single-use, 15-minute TTL, bound to the invoking Discord user, and hashed at rest.",
  },
  code: [
    {
      filename: "src/discord.ts",
      code: WIRING_CODE,
      caption:
        "The four callbacks that make /link work: mintCode (engine-throttled), sendLinkCode (transactional, skipPreferenceCheck), redeemCode (single-use + identity-bound), and the engine helpers injected so the plugin stays free of internals.",
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
      title: "The code rides a transactional send",
      body: 'sendLinkCode uses emailService.send with category: "transactional" and skipPreferenceCheck: true, so the verification code is never dropped by an unsubscribe or a frequency cap — routing it through the journey-category sendEmail would silently lose it for unsubscribed users.',
    },
    {
      title: "Single-use, TTL-bound, identity-bound",
      body: "redeemLinkCode is an atomic claim: a code works exactly once, expires after 15 minutes, and the engine re-checks the invoking Discord user with a constant-time compare — a code minted for one account cannot be redeemed by another.",
    },
    {
      title: "The throttles run before the mint",
      body: "createLinkCode counts mints per invoking Discord user (5) and per target email (3) in a rolling 15-minute window before issuing a code, so an over-cap /link returns ok:false with no email sent — an anti-email-bomb backstop. An optional Redis /verify throttle (10/user/15 min, fail-open) blunts brute-force redeem traffic.",
    },
    {
      title: "discord_id is the sole merge key",
      body: "redeemCode resolves through resolveOrCreateContact with the discord identity Kind, so the raw snowflake lands in the indexed discord_id column. contacts.properties.discord is decorative metadata, deep-merged and non-clobbering — never a resolution key.",
    },
  ],
  faq: [
    {
      q: "Why a modal and a button instead of one form?",
      a: "Discord forbids returning a modal directly from a modal submit, so the flow is email modal → Enter code button → code modal. Every step is ephemeral and no message body ever echoes the email or code. /verify <code> is the typed fallback when someone would rather not click through.",
    },
    {
      q: "What email gets linked — the one typed or the Discord account's email?",
      a: "The one typed into the /link modal, carried through the engine-verified state. The OAuth member-link fallback uses the address the link was issued for, never the OAuth-reported Discord email — using the latter as a resolution key would let a member attach an address they do not own.",
    },
    {
      q: "How do I read the linked identity in a journey?",
      a: "JourneyUser carries id/email/properties but not the nested Discord metadata. Read the authoritative contacts row: the discord_id column is the merge key, contact.email tells you linked vs Discord-only, and contacts.properties.discord holds username, global_name, avatar, joined_at, roles, and the derived last_seen.",
    },
    {
      q: "Is the OAuth member-link available?",
      a: "Not yet end to end — the one-click install and OAuth member-link (hogsend connect discord) need consumer-mounted secrets/wire admin routes that apps/api does not mount today, so that CLI 404s. The in-Discord /link modal is the primary, live path; OAuth member-link is a planned fallback.",
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
