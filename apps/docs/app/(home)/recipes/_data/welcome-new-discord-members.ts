import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const welcomeNewDiscordMembers = defineJourney({
  meta: {
    id: "welcome-new-discord-members",
    name: "Onboarding — welcome new Discord members",
    enabled: true,
    // The join event the Discord connector emits on GUILD_MEMBER_ADD.
    trigger: { event: Events.DISCORD_MEMBER_JOINED },
    entryLimit: "once",
    suppress: hours(12),
    exitOn: [{ event: Events.DISCORD_MEMBER_LEFT }],
  },

  run: async (user, ctx) => {
    // A fresh join has a discord_id but usually no linked email yet. Park on
    // the link event the /link → /verify loop fires when it resolves the
    // contact; lookback covers a member who linked seconds before this wait.
    const linked = await ctx.waitForEvent({
      event: Events.CONTACT_LINKED,
      timeout: days(2),
      lookback: minutes(30),
    });

    if (linked.timedOut) {
      // Two days, still no email: nudge IN Discord via the destination, since
      // there is no address to email. The destination posts to the channel.
      await ctx.trigger({
        event: Events.DISCORD_NUDGE_LINK,
        userId: user.id,
        properties: { reason: "unlinked-2d" },
      });
      return;
    }

    // They linked — user.email is now an address we can send to.
    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.DISCORD_WELCOME,
      subject: "Welcome to the community — here's where to start",
      journeyName: user.journeyName,
    });
  },
});`;

const LINK_FIRE_CODE = `// A tiny companion journey re-emits contact.linked so the welcome's wait
// resumes. ctx.trigger injects the registry/hatchet/logger the ingest pipeline
// needs — a bare redeemCode callback in src/discord.ts can't reach them, so a
// raw ingestEvent({ db, registry, hatchet, logger, event }) is not callable
// there. Trigger on the member's first post-link activity instead.
export const emitContactLinked = defineJourney({
  meta: {
    id: "emit-contact-linked",
    name: "Discord — emit contact.linked once linked",
    enabled: true,
    trigger: { event: Events.DISCORD_MESSAGE_SENT },
    entryLimit: "once",
    suppress: hours(12),
  },

  run: async (user, ctx) => {
    // Only once the /link loop folded an email onto the discord_id contact.
    if (!user.email) return;

    await ctx.trigger({
      event: Events.CONTACT_LINKED, // "contact.linked"
      userId: user.id,
      properties: { source: "discord", method: "verify" },
    });
  },
});`;

export const welcomeNewDiscordMembers: RecipeLander = {
  slug: "welcome-new-discord-members",
  category: "onboarding",
  title: "Welcome new Discord members",
  metaDescription:
    "A welcome journey triggered by the discord.member_joined event: wait for the member to link an email with ctx.waitForEvent, send a welcome on the link, and nudge the still-unlinked in-channel via the Discord destination.",
  cardDescription:
    "On a Discord join, wait for the member to link an email — then welcome them, or nudge the unlinked in-channel.",
  eyebrow: "Recipe — Onboarding & activation",
  subhead:
    "discord.member_joined upserts a contact with a discord_id but no email; this journey parks on the link event, sends the welcome the instant the contact resolves, and routes an in-Discord nudge for anyone who never links.",
  problem: {
    label: "The no-address-yet problem",
    statement:
      "A new Discord member arrives as a snowflake, not an email. A welcome email cannot fire on the join itself — there is no address. Sending a fixed-delay welcome guesses at when (or whether) they will link, and an in-channel nudge for the unlinked is a separate code path that usually never gets built, so half the cohort gets nothing.",
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "The welcome is gated on the link, not a timer",
    subtitle:
      "The join starts the run; ctx.waitForEvent holds it until the contact links an email; the branch sends the welcome to linked members and nudges the unlinked through the channel destination.",
    note: "The member joins with a discord_id only. The welcome path needs user.email, which exists only after the /link loop resolves the contact — so the journey waits for that link event instead of sending blind.",
  },
  code: [
    {
      filename: "src/journeys/welcome-new-discord-members.ts",
      code: JOURNEY_CODE,
      caption:
        "waitForEvent on the link event is the gate: linked → email the welcome; timed out → ctx.trigger an in-Discord nudge, because there is still no address to send to.",
    },
    {
      filename: "src/journeys/emit-contact-linked.ts",
      code: LINK_FIRE_CODE,
      caption:
        "A companion journey re-emits contact.linked via ctx.trigger once the member is emailable, resuming the welcome's wait — ctx.trigger supplies the registry/hatchet/logger a raw ingestEvent() call would need but a consumer callback can't reach.",
    },
  ],
  points: [
    {
      title: "The join is a real contact upsert",
      body: "discord.member_joined runs the same ingestion pipeline as every other event: stored in user_events, routed to this journey, and upserted onto a contact carrying discord_id plus the discord metadata object — so the run has a stable user.id from the first step.",
    },
    {
      title: "The welcome waits for an address",
      body: "There is no email on a raw join. ctx.waitForEvent holds the run until the /link loop resolves the contact and fires contact.linked, so the welcome email sends to a real, linked address and never to an empty user.email.",
    },
    {
      title: "The unlinked get an in-channel nudge, not silence",
      body: "When the link never lands, ctx.trigger fires an event the Discord destination turns into a channel post — the one cohort that cannot be emailed still gets a touch, through the surface they are actually on.",
    },
    {
      title: "One welcome per member, exit on leave",
      body: 'entryLimit: "once" means a re-join never re-welcomes, and exitOn on the member-left event cancels the run mid-wait if they leave the server — no welcome chasing someone who is already gone.',
    },
  ],
  faq: [
    {
      q: "Why can't the welcome email fire on discord.member_joined directly?",
      a: "A join carries a Discord snowflake, not an email. user.email is empty until the contact links an address through the /link → /verify loop. Sending on the join would mean sending to nobody — so the journey waits for the link event first.",
    },
    {
      q: "How does the member link their email?",
      a: "Inside Discord: /link opens an email modal, Hogsend emails a 6-digit code, and an Enter code button (or /verify <code>) resolves the contact. A small companion journey then re-emits contact.linked via ctx.trigger on the member's next activity, which resolves this journey's wait. See Link a Discord account to an email.",
    },
    {
      q: "What does the in-channel nudge actually do?",
      a: "ctx.trigger fires a catalog event the Discord destination is subscribed to; the destination's transform posts a Discord-markdown line to the configured channel via an incoming webhook. The nudge reaches the member on Discord because that is the only surface available for an unlinked contact.",
    },
    {
      q: "Does leaving the server stop the journey?",
      a: "If you emit a member-left event (e.g. from a GUILD_MEMBER_REMOVE handler) and list it in exitOn, yes — the run is cancelled even mid-wait. Presence going offline does not exit the journey; only the explicit leave event does.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/welcome-new-discord-members",
    },
    {
      label: "Discord integration — events and identity",
      href: "/docs/integrations/discord",
    },
    {
      label: "Journeys guide — waitForEvent and ctx.trigger",
      href: "/docs/guides/journeys",
    },
  ],
  related: [
    "link-discord-to-email",
    "welcome-series",
    "route-a-reaction-as-a-signal",
  ],
};
