import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const routeReactionSignal = defineJourney({
  meta: {
    id: "route-a-reaction-as-a-signal",
    name: "Human-in-the-loop — reaction signal",
    enabled: true,
    // Only a 👍 reaction enters. The connector puts the emoji name in
    // eventProperties.emoji; trigger.where filters on it at enrollment.
    trigger: {
      event: Events.DISCORD_REACTION_ADDED,
      where: (b) => b.prop("emoji").eq("👍"),
    },
    entryLimit: "once_per_period",
    entryPeriod: days(1),
    suppress: hours(12),
  },

  run: async (user, ctx) => {
    const db = getDb();
    const contact = await db.query.contacts.findFirst({
      where: eq(contacts.id, user.id),
    });

    // The reaction is the hand-raise. Flag it with a scalars-only event the
    // notify task (or the Discord alerts destination) turns into an operator
    // touch — identity is resolved server-side, never carried in properties.
    await ctx.trigger({
      event: Events.LEAD_FLAGGED,
      userId: user.id,
      properties: {
        reason: "discord-reaction",
        emoji: "👍",
        linked: Boolean(contact?.email),
        flaggedAt: new Date().toISOString(),
      },
    });
  },
});`;

const PROPS_CODE = `// discord.reaction_added carries the emoji name (and channel/message ids) in
// eventProperties — set by the connector's transform:
//   eventProperties: {
//     source: "discord",
//     channelId, guildId,
//     messageId,
//     emoji: d.emoji?.name ?? null,   // "👍", "🚀", a custom name, or null
//   }
//
// trigger.where filters on those props at enrollment, so only the reactions
// you care about ever create journey state:
trigger: {
  event: Events.DISCORD_REACTION_ADDED,
  where: (b) => b.prop("emoji").eq("👍"),
}`;

export const routeAReactionAsASignal: RecipeLander = {
  slug: "route-a-reaction-as-a-signal",
  category: "human-in-the-loop",
  title: "Route a Discord reaction as a signal",
  metaDescription:
    "Turn a specific Discord reaction into a hand-raise: a defineJourney() triggered by discord.reaction_added with a trigger.where on the emoji name resolves the contact and fires a scalars-only lead.flagged event for an operator to follow up.",
  cardDescription:
    "A specific reaction becomes a hand-raise — filtered at enrollment, flagged for a human to follow up.",
  eyebrow: "Recipe — Human-in-the-loop",
  subhead:
    "discord.reaction_added carries the emoji name in its properties; a trigger.where filters enrollment to a single emoji, and the journey flags a scalars-only lead.flagged event the notify task or Discord channel destination turns into an operator touch.",
  problem: {
    label: "The lost-signal problem",
    statement:
      "A reaction is the lowest-friction hand-raise a community produces and the easiest to miss. Every reaction firing a journey would flood the system; matching the right emoji inside the run wastes an enrollment on every other reaction; and carrying the member's identity in the event properties leaks it to every destination the event fans out to.",
  },
  walkthrough: {
    eyebrow: "The seam",
    title: "Filter at enrollment, flag for a human",
    subtitle:
      "trigger.where matches the emoji name before any state is created, so only the intended reaction enters; the run resolves identity from the contacts row and fires a scalars-only flag for a person to act on.",
    note: "The emoji name lives in eventProperties.emoji, set by the connector's transform. The where-builder reads it at enrollment, so a 👍 enters and a 😂 never does — no wasted journey state and no in-run emoji branching.",
  },
  code: [
    {
      filename: "src/journeys/route-a-reaction-as-a-signal.ts",
      code: JOURNEY_CODE,
      caption:
        "trigger.where filters to a single emoji at enrollment; the run fires a scalars-only lead.flagged that carries reason and linked state — never the member's email or name.",
    },
    {
      filename: "the reaction's event properties",
      code: PROPS_CODE,
      caption:
        "discord.reaction_added carries emoji, channelId, guildId, and messageId; trigger.where reads emoji at enrollment so only the reactions you choose create journey state.",
    },
  ],
  points: [
    {
      title: "The filter runs before any state exists",
      body: "trigger.where is evaluated by the enrollment guard against the event properties, so a non-matching emoji is skipped with no journeyStates row created. Matching the emoji inside the run instead would burn an enrollment on every reaction in the server.",
    },
    {
      title: "The flag is scalars-only",
      body: "Event properties travel the ingest pipeline and fan out to destinations, so lead.flagged carries reason, the emoji, and the linked flag — never the member's email or name. The notify task reads identity from the authoritative contacts row.",
    },
    {
      title: "Identity is resolved server-side",
      body: "The reaction carries a discord_id on the IngestEvent.discordId field, which folds onto the contacts.discord_id column; the run reads the contacts row to learn whether the member has linked an email. A linked member can be emailed; an unlinked one is paged through the Discord channel destination.",
    },
    {
      title: "Re-flagging is rate-limited",
      body: 'entryLimit: "once_per_period" with entryPeriod: days(1) means the same member spamming the same reaction flags at most once a day, so an operator is paged on a genuine signal, not on a reaction storm.',
    },
  ],
  faq: [
    {
      q: "How does the journey know which emoji was used?",
      a: 'The connector puts the emoji name in eventProperties.emoji ("👍", a custom emoji name, or null). trigger.where reads it with the property builder — b.prop("emoji").eq("👍") — so enrollment is filtered to exactly that reaction before the run starts.',
    },
    {
      q: "Why fire lead.flagged instead of acting in the journey?",
      a: "Decoupling the signal from the action. A scalars-only flag can be picked up by a notify-lead Hatchet task (for an operator email past the lead's own preferences) or by the Discord alerts destination (for a channel post) — without the journey knowing or caring which. See Lead alerts and Discord engagement alerts.",
    },
    {
      q: "Can I match a custom server emoji?",
      a: 'Yes — custom emoji arrive by name in eventProperties.emoji, so b.prop("emoji").eq("my_custom_name") matches the same way. A reaction whose name does not resolve arrives as null and is filtered out by an equality where.',
    },
    {
      q: "Does the member need a linked email for this to work?",
      a: "No — the reaction always carries a discord_id, so the flag fires regardless. The run records whether an email is linked, so the follow-up can branch: email a linked member, or post to the channel for a Discord-only one.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/route-a-reaction-as-a-signal",
    },
    {
      label: "Discord integration — reaction event properties",
      href: "/docs/integrations/discord",
    },
    {
      label: "Lead alerts — the operator follow-up",
      href: "/docs/recipes/lead-alerts",
    },
    {
      label: "Journeys guide — trigger.where and ctx.trigger",
      href: "/docs/guides/journeys",
    },
  ],
  related: [
    "lead-alerts",
    "discord-engagement-alerts",
    "welcome-new-discord-members",
  ],
};
