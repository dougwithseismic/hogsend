import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const reEngageQuietDiscordMembers = defineJourney({
  meta: {
    id: "re-engage-quiet-discord-members",
    name: "Retention — re-engage quiet Discord members",
    enabled: true,
    // Re-evaluate on each presence ping; the entry guard rate-limits re-entry.
    trigger: { event: Events.DISCORD_PRESENCE_ACTIVE },
    entryLimit: "once_per_period",
    entryPeriod: days(30),
    suppress: hours(12),
  },

  run: async (user, ctx) => {
    const db = getDb();
    const contact = await db.query.contacts.findFirst({
      where: eq(contacts.id, user.id),
    });

    // No linked email → nothing to send. last_seen is the DERIVED first-party
    // signal (max of observed Discord events), not Discord presence.
    if (!contact?.email) return;

    const meta = (contact.properties?.discord ?? {}) as {
      last_seen?: string;
      username?: string;
    };
    const lastSeen = meta.last_seen ? new Date(meta.last_seen) : null;
    if (!lastSeen) return;

    const quietDays = (Date.now() - lastSeen.getTime()) / 86_400_000;
    if (quietDays < 30) return; // still active enough — no win-back

    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: contact.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.DISCORD_WINBACK,
      subject: \`We've missed you in the server, \${meta.username ?? "friend"}\`,
      journeyName: user.journeyName,
    });
  },
});`;

const READ_CODE = `// contacts.properties.discord.last_seen is DERIVED first-party — the max of
// observed Discord event timestamps (message snowflake time for messages,
// receipt time for reactions/joins/presence). Discord has no last-seen field,
// and presence is collapsed to "active" (offline/absent dropped), so presence
// is NOT a last-seen feed. Read it as a plain ISO string off the contact.
const meta = (contact.properties?.discord ?? {}) as { last_seen?: string };
const lastSeen = meta.last_seen ? new Date(meta.last_seen) : null;
const quietDays = lastSeen
  ? (Date.now() - lastSeen.getTime()) / 86_400_000
  : Infinity;`;

export const reEngageQuietDiscordMembers: RecipeLander = {
  slug: "re-engage-quiet-discord-members",
  category: "retention",
  title: "Re-engage quiet Discord members",
  metaDescription:
    "Win back inactive Discord members by reading the derived first-party last_seen on contacts.properties.discord: compute inactivity in a presence-gated journey and email a win-back, framing last_seen as a derived signal rather than Discord presence.",
  cardDescription:
    "Read the derived last_seen on a contact, find members quiet for 30 days, and email a win-back.",
  eyebrow: "Recipe — Retention & engagement",
  subhead:
    "A presence-gated journey reads contacts.properties.discord.last_seen — the derived max of observed Discord events — computes days of inactivity, and emails a win-back only to linked, subscribed, genuinely quiet members.",
  problem: {
    label: "The presence-is-not-activity problem",
    statement:
      "Discord exposes presence (online/idle/dnd) but no last-seen timestamp, and presence is noisy — a member can show online for days while never posting. Treating presence as activity wins back nobody, and there is no built-in signal for how long someone has actually been quiet. Without a derived last-seen, a win-back is a guess.",
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "Inactivity from a derived signal",
    subtitle:
      "Hogsend stamps last_seen from the timestamp of every observed Discord event, so the journey computes real inactivity off the contact row and sends only to members who are linked, subscribed, and genuinely quiet.",
    note: "last_seen is the max of observed message/reaction/join/presence timestamps — derived first-party because Discord has no such field. Presence going online does not by itself mean the member is active; an actual message advances last_seen, a presence ping is a weaker signal.",
  },
  code: [
    {
      filename: "src/journeys/re-engage-quiet-discord-members.ts",
      code: JOURNEY_CODE,
      caption:
        "The win-back is gated three ways: a linked email, a last_seen older than 30 days, and a still-subscribed contact — so it never fires for the unlinked, the active, or the unsubscribed.",
    },
    {
      filename: "reading the derived signal",
      code: READ_CODE,
      caption:
        "last_seen is a plain ISO string on contacts.properties.discord; subtract it from now for inactivity. It is derived from observed events, never read from Discord.",
    },
  ],
  points: [
    {
      title: "last_seen is computed, not reported",
      body: "Discord has no last-seen field. The connector stamps contacts.properties.discord.last_seen from the timestamp of every inbound event — message snowflake time for messages, receipt time for reactions/joins/presence — so the journey reads a real first-party activity signal.",
    },
    {
      title: "Presence is not the win-back trigger by itself",
      body: 'discord.presence_active fires the journey only as a re-evaluation tick; the actual decision is the last_seen math. Presence is collapsed to "active" (offline and absent are dropped), so it is a coarse heartbeat, not a measure of participation.',
    },
    {
      title: "Re-entry is rate-limited, not unbounded",
      body: 'entryLimit: "once_per_period" with entryPeriod: days(30) means a member is re-evaluated for win-back at most once a month, even though presence pings arrive constantly — the enrollment guard absorbs the firehose before any state is created.',
    },
    {
      title: "Three gates before a send",
      body: "An unlinked contact has no address (skip), an active one has a recent last_seen (skip), and an unsubscribed one fails ctx.guard.isSubscribed() (skip). Only a linked, quiet, subscribed member receives the win-back.",
    },
  ],
  faq: [
    {
      q: "Why not trigger on a dormancy bucket like the win-back-and-sunset recipe?",
      a: "You can, and for email-driven dormancy a bucket is cleaner. This recipe shows the Discord-native signal: last_seen lives on the contact's discord metadata, so a presence-gated journey reading that field needs no bucket. For a full sunset policy on top, compose this with the Win-back and sunset recipe.",
    },
    {
      q: "Does a presence ping mean the member is active?",
      a: 'Not really. Presence is collapsed to "active" by dropping offline/absent statuses, so it is a heartbeat that someone is connected, not that they participated. last_seen advances on real activity (a message updates it to the message time); lean on last_seen, not on the presence event, for the inactivity decision.',
    },
    {
      q: "What if the member is Discord-only with no email?",
      a: "There is no address to win them back by email, so the journey returns early. To reach an unlinked member, post to the channel via the Discord destination instead — or run the link loop first (Link a Discord account to an email).",
    },
    {
      q: "Can I window the trigger to avoid running on every presence ping?",
      a: "The entry guard already does the heavy lifting: once_per_period caps re-entry to once per 30 days regardless of how many presence events arrive. You can also add a trigger.where to only enter on, say, presence after a quiet streak, but the period guard alone keeps the cost bounded.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/re-engage-quiet-discord-members",
    },
    {
      label: "Discord integration — derived last_seen",
      href: "/docs/integrations/discord",
    },
    {
      label: "Win-back and sunset — the full lapsed policy",
      href: "/docs/recipes/winback-and-sunset",
    },
  ],
  related: ["winback-and-sunset", "link-discord-to-email", "weekly-digest"],
};
