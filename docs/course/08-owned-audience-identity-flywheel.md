# Chapter 8 — The owned-audience flywheel

*Turn ad clicks and visitors into verified emails and linked Discord/Telegram accounts —
an audience you own, can reach for free, and can build a referral loop on.*

> **In this chapter:** why an owned channel beats a rented ad audience, the
> "link-your-account-for-a-perk" mechanic that captures identity, how email
> verification and Discord/Telegram linking build an identity graph, and how that graph
> makes referral loops actually work. Code mirrors Hogsend's real connectors.

This is the chapter that answers the original question: *how does a lifecycle tool start
driving traffic?* The answer is that lifecycle and acquisition meet at **identity** —
the more channels a person links, the cheaper they are to reach, the better your ads
perform, and the more your referrals compound.

---

## 8.1 Owned beats rented

Every ad audience is **rented.** You pay to reach those people the first time, and you
pay again every time you want to reach them after that. The moment you stop paying, the
channel goes dark.

An **owned** channel — a verified email address, a linked Discord or Telegram account —
is the opposite. Once someone is in it:

- **There's no algorithm tax.** A Discord post or Telegram message reaches your members
  directly; an email lands in the inbox. No boost, no bid, no feed gatekeeper deciding
  who sees it.
- **Reactivation is nearly free.** Bringing a lapsed user back through an owned channel
  costs a fraction of re-buying the ad impression.

The exact multiples you'll see quoted — "acquiring costs 5–25× more than retaining,"
"owned reactivation is 5–10× cheaper than paid" — are **directional folklore** with
loose sourcing; don't repeat the decimals as fact. But the **mechanism is undeniable**
and it's the load-bearing argument of this chapter: *a one-time ad spend that captures
someone into an owned channel converts a rented impression into a reusable asset.* You
pay once to acquire the contact, then reach them as often as you like for free.

This is why a lifecycle tool is the natural place for acquisition to *land*. Ads bring
people; lifecycle keeps them; the bridge between the two is the moment you capture their
identity into a channel you own.

---

## 8.2 The capture mechanic: a perk for linking

People don't hand over their email or link their Discord out of goodwill. They do it for
a **perk.** The pattern, across every community that does this well:

> **"Link your account / verify your email → get [a role, a perk, access, credits, a
> whitelist spot]."**

The perk is the conversion event, and the conversion *is* the identity capture. Examples
worth modelling:

- **Web3 / token-gating:** Collab.Land and Guild.xyz let a member connect a wallet, the
  bot verifies an on-chain holding, and a role unlocks gated channels or whitelist
  spots. Guild's primitive is literally **Requirements → Roles → Rewards**.
- **Quest platforms** (Zealy, Galxe, Layer3): daily actions earn XP, roles, and airdrop
  eligibility — a structured engagement loop.
- **Email-verify-for-role** (the non-web3 analog, and Hogsend's pattern): the bot links
  to a verification page; the user confirms their **email**; they get a "Verified" role
  and its perks. This is the move that produces an **email ↔ Discord** link you own —
  and several tools market it openly as list-building.

The reward should map to your product's value and live *in the owned channel* where
possible, so claiming it deepens the relationship rather than ending it.

---

## 8.3 Linking Discord, with email verification

Here's the mechanic in Hogsend terms. The Discord cold-connect flow lets a member run
`/link you@example.com`; the engine emails a single-use confirmation link; clicking it
**proves inbox ownership**, binds `discord ↔ email`, and emits a `discord.linked` event
you can build on.

The important design principle — and the one that makes the captured email *trustworthy*
— is that **the typed address is never trusted until the email is clicked.** The
delivered-and-clicked email *is* the proof. That's what makes the resulting email both
real and consented (which matters for Chapter 7's ad uploads).

Once `discord.linked` fires, a journey welcomes them and grants the role:

```ts
import { defineJourney, sendConnectorAction, sendEmail } from "@hogsend/engine";
import { Events, Templates } from "./constants/index.js";

export const discordLinked = defineJourney({
  meta: {
    id: "discord-linked",
    name: "Discord — Linked & Verified",
    enabled: true,
    trigger: { event: Events.DISCORD_LINKED }, // fires after the email is confirmed
    entryLimit: "once",
  },
  run: async (user) => {
    const discordId = String(user.properties.discordId ?? "");
    const guildId = String(user.properties.guildId ?? "");

    // Grant the "Verified / Community" role — the perk that prompted the link.
    await sendConnectorAction({
      connectorId: "discord",
      action: "grantRole",
      args: { guildId, member: discordId, roleId: process.env.DISCORD_ROLE_COMMUNITY ?? "" },
    });

    await sendConnectorAction({
      connectorId: "discord",
      action: "dmMember",
      args: { member: discordId, content: "✅ Verified! You've unlocked the community channels." },
    });

    // Now they're reachable by BOTH email and Discord — an owned, multi-channel contact.
    await sendEmail({
      to: user.email, userId: user.id, journeyStateId: user.stateId,
      template: Templates.ACTIVATION_COMMUNITY,
      subject: "You're in — here's how to get the most from the community",
      journeyName: user.journeyName,
    });
  },
});
```

The same `sendConnectorAction` primitive drives **gamification** — granting roles for
community engagement, which both rewards members and densifies the graph. Hogsend's
real Discord journeys do exactly this: grant a "Hello world" role on a first message, a
"Resonator" role when a member's post gets reactions from five different people, a "Hype
hog" role for reacting to five different people's posts. Each engagement is an event;
each role is a `grantRole` action; each is another edge in the identity graph.

---

## 8.4 Linking Telegram

Telegram has no native email field — identity is phone-based — so linking uses a bot
deep-link plus an email-confirm flow, the same proof-by-clicking pattern as Discord. A
member runs `/link you@example.com`; the journey emails a single-use confirm link:

```ts
export const telegramLinkRequest = defineJourney({
  meta: {
    id: "telegram-link-request",
    name: "Telegram — Link Request (/link)",
    enabled: true,
    trigger: { event: TelegramEvents.LINK_REQUESTED },
    entryLimit: "unlimited",
  },
  run: async (user) => {
    const chatId = String(user.properties.chatId ?? "");
    const fromId = String(user.properties.fromId ?? "");
    const email = String(user.properties.email ?? "");

    const reply = (text) =>
      sendConnectorAction({ connectorId: "telegram", action: "sendMessage", args: { chatId, text } });

    if (!email) {
      await reply("To connect your email, send:\n\n/link you@example.com");
      return;
    }

    // Mint a server-sealed, single-use confirm token (rate-limited, fail-closed).
    const minted = await telegramColdConnect.mintConfirm({ platformUserId: fromId, email });
    if (!minted.ok) {
      await reply("Linking is briefly unavailable — please try again shortly.");
      return;
    }

    const url = telegramColdConnect.confirmUrl({ apiPublicUrl: process.env.API_PUBLIC_URL, token: minted.token });
    await getEmailService().send({
      template: "transactional/magic-link",
      props: { magicLinkUrl: url, expiresIn: "15 minutes" },
      to: email, userId: email, userEmail: email,
      subject: "Confirm your Telegram connection",
      category: "transactional",
      skipPreferenceCheck: true,
    });
    await reply(`📧 I've emailed a confirmation link to ${email}. Open it to finish — expires in 15 minutes.`);
  },
});
```

Clicking the link binds `telegram ↔ email` and stitches the analytics identity from the
client (so you get the real geo/IP). Referrals on Telegram ride the same deep-link
mechanism: a unique `t.me/<bot>?start=<referrerId>` link lets the bot record who brought
whom.

---

## 8.5 The identity graph (why this compounds)

Every link event writes an **edge** between two ways of reaching the same person:

```
email ↔ Discord ID ↔ Telegram ID ↔ wallet ↔ anonymous web id ↔ PostHog person
```

Collect enough edges and you have an **identity graph**: one unified profile that spans
devices, sessions, and channels. The payoffs stack:

- **Retroactive stitching.** When an anonymous visitor finally gives an email or links
  Discord, all their prior touchpoints attach to the now-known profile — so attribution
  works on data *you own*, independent of cookies.
- **Channel choice on reactivation.** A lapsed user isn't reachable only by an ad you
  must re-buy — you can email them, ping them in Discord, or DM them on Telegram. The
  denser the graph, the more ways back in.
- **Better ads, legally.** Those verified, consented emails are exactly the high-EMQ
  custom-audience and lookalike-seed inputs from Chapter 7. The graph you build here is
  the fuel the ad machine there runs on.

Hogsend builds this graph on its **own** identity model (it stitches email ↔ channel ↔
anonymous), and its connectors emit the engagement events — `discord.linked`,
`reaction_added`, `member.joined`, `link.clicked` — that both trigger journeys *and* add
edges. The graph is the hub of the flywheel; every channel you link spins it faster.

---

## 8.6 The referral loop

Referrals are where the owned graph pays off most, because **a referral program only
works if you can attribute it** — and attribution is exactly what the graph gives you.

### Incentive structures that work

- **Double-sided (give-get).** Reward *both* the referrer and the new user. It removes
  the "I'm asking a favour" friction. **Dropbox** is the canonical case: 500 MB of
  storage to *each side* per referral, capped at 16 GB. The reward was the product's own
  core value, the ask was the last step of onboarding, and it drove **~3,900% growth in
  15 months.** (The backstory: paid ads were costing Dropbox far more than a customer was
  worth, so a product-value referral was dramatically cheaper.)
- **Milestone / tiered.** An escalating ladder of rewards — **Morning Brew**'s newsletter
  referral program (stickers → shirt → bigger swag → trip to HQ) is the model, with a
  leaderboard for status. Near-zero marginal cost per reward; great for community.
- **Status / access.** For pre-launch and web3/games, the reward is *earlier access*, a
  *whitelist spot*, or an *exclusive role* — scarcity instead of cash. **Robinhood**'s
  skip-the-line waitlist is the classic.

Design principles across all of them: make sharing effortless (prewritten copy, a
one-click link), reward both sides, align the reward to product value, show progress
(a dashboard or leaderboard), and **trigger the ask at peak engagement** — right after
the aha moment, which is the referral journey from Chapter 6, §6.7.

### Why the owned graph makes attribution work

Cookie-based referral tracking breaks on the exact journey referrals take: a friend
shares a link, the recipient clicks on their phone, then signs up on a laptop weeks
later. Last-click misses it; the referrer goes uncredited; the program looks like it
doesn't work and gets cut.

An owned identity graph fixes this:

- First-party referral codes/links are tracked **independent of third-party cookies**,
  so you capture the conversion even as browsers tighten.
- The graph **resolves the new user across devices** and **back-credits the referrer**
  when the anonymous visitor finally identifies (gives email / links Discord).
- You can enforce **anti-fraud rules** — the referee must verify their email or link an
  account or hit a real milestone before the reward fires — because the *whole graph is
  yours*. A Discord-linked referral resolves to a real verified person, not a cookie.

And the natural community fit closes the loop: **"X verified referrals → unlock a Discord
role"** puts the reward *in the owned channel*, which densifies the graph further. The
reward for growing your audience is itself a deeper hook into your audience.

Hogsend ships a referral v1 on exactly this shape: `visited → converted → credited`, two
journeys plus a Discord role granted at a milestone — all on its own identity graph, no
cookies required.

---

## 8.7 The full funnel, assembled

Putting Chapters 7 and 8 together, this is the complete path — and every stage captures
an identity edge:

| Stage | Goal | What's captured |
|---|---|---|
| **Ad / content** | Cold reach | `fbclid` / UTM on the landing page |
| **Landing** | Intent | anon id stitched to the click |
| **Email capture + verify** | Own the contact | **email** (consented) |
| **Discord/Telegram link (perk)** | Densify the graph | **email ↔ Discord/Telegram** |
| **Lifecycle journeys** | Activate & retain | engagement events on your own spine |
| **Referral loop** | Compound | referrer ↔ referee edge, often a Discord role |

The feedback loops that make it a flywheel rather than a funnel:

- Verified emails → **custom audiences + lookalike seeds** → cheaper, better-matched ads
  (Chapter 7).
- Server-side deep conversions → **smarter Meta optimisation** (Chapter 7).
- Owned channels → **near-free reactivation** (this chapter).
- Referrals → **growth that lowers blended CAC over time** (this chapter).

The identity graph sits at the hub. Every turn of the loop adds edges, and every edge
makes the next turn cheaper.

---

## 8.8 Do this now

1. Pick the **perk** that's worth linking for (a role, access, credits, a whitelist).
2. Stand up the **Discord and/or Telegram connector** and the `/link` email-verify flow.
3. Build the **`discord-linked` / `telegram-linked`** journey to grant the perk and
   welcome them across both channels.
4. Add the **referral ask** at your aha milestone (Chapter 6, §6.7) and reward verified
   referrals with a role.
5. Sync your **verified, consented emails** as a Meta custom audience and lookalike seed
   (Chapter 7).

You now have the whole machine. The final chapter sequences it into a plan.

---

*Sources for this chapter: [Guild.xyz](https://help.guild.xyz/en/articles/6934383-introduction-to-guild),
[Collab.Land token-gating](https://docs.collab.land/help-docs/key-features/token-gate-communities/),
[Supabase community-led growth](https://medium.com/craft-ventures/inside-supabases-product-community-led-growth-e4799823fbb2),
[Dropbox referral program](https://growsurf.com/blog/dropbox-referral-program),
[double-sided referral programs](https://www.voucherify.io/blog/how-to-launch-a-double-sided-referral-program),
[first-party identity graphs](https://www.cometly.com/post/first-party-identity-graph),
[Telegram bot links](https://core.telegram.org/api/links). Hogsend connector details:
this project's `docs/connect-discord.md`, `docs/connector-runtime.md`, and the journeys
in `apps/api/src/journeys/`.*

---

[← Chapter 7](./07-driving-traffic.md) · [Course index](./README.md) · **Next:** [Chapter 9 — Putting it all together →](./09-putting-it-all-together.md)
