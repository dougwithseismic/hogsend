import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Eyebrow, PillBadge, TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { CopyButton } from "@/components/ds/copy-button";
import { Reveal } from "@/components/ds/reveal";
import { Section } from "@/components/ds/section";
import { cn } from "@/lib/cn";
import { ENGINE_VERSION, GITHUB_URL, RAILWAY_DEPLOY_URL } from "@/lib/site";

// TODO: /changelog/rss.xml when entries move to MDX

export const metadata: Metadata = {
  title: "Changelog",
  description:
    "Every Hogsend release: features, fixes, and upgrade notes for the source-available lifecycle email engine. Upgrades are pnpm up, never a merge.",
};

const SCAFFOLD_COMMAND = "pnpm dlx create-hogsend@latest my-app";

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="whitespace-nowrap rounded-[3px] border border-white/10 bg-white/[0.06] px-1.5 py-0.5 font-mono text-[0.85em] text-white/90">
      {children}
    </code>
  );
}

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-3 text-base text-white/70 leading-6">
      <span
        aria-hidden="true"
        className="mt-[9px] size-1.5 shrink-0 rounded-[1px] bg-accent/80"
      />
      <span>{children}</span>
    </li>
  );
}

type ChangelogEntry = {
  version: string;
  anchor: string;
  date: string;
  title: string;
  bullets: ReactNode;
  upgradeNote?: ReactNode;
};

/*
 * Facts verified against packages/engine/CHANGELOG.md and git tags
 * (dates are the real tag dates).
 */
const ENTRIES: ChangelogEntry[] = [
  {
    version: "0.31.0",
    anchor: "0-31-0",
    date: "June 24, 2026",
    title: "Studio-styled connect page + platform logos",
    bullets: (
      <>
        <Bullet>
          The engine-served connect page (
          <Code>{"GET /connect/<connector>"}</Code>) — where a contact confirms
          a Telegram or Discord email link — is restyled to the Hogsend Studio
          design language: ink surface, hairline card, the real Telegram /
          Discord logo, and an &ldquo;if this wasn&rsquo;t you, ignore
          this&rdquo; reassurance line. It&rsquo;s engine-owned, so every
          cold-connect connector inherits the look.
        </Bullet>
        <Bullet>
          Hardened: the branding JSON embedded in the page&rsquo;s inline{" "}
          <Code>{"<script>"}</Code> is escaped against a{" "}
          <Code>{"</script>"}</Code> breakout, the new <Code>iconSvg</Code>{" "}
          branding field is shape-checked (fails closed to the emoji badge), the
          page clears WCAG AA contrast, and it no longer pulls a third-party
          webfont.
        </Bullet>
        <Bullet>
          <Code>create-hogsend</Code> is realigned to the engine version line —
          it had drifted to <Code>0.22.0</Code> while the line reached{" "}
          <Code>0.30.0</Code>, so <Code>create-hogsend@latest</Code> scaffolded
          a stale app. <Code>release-doctor</Code> now holds the scaffolder to
          the line so it can&rsquo;t fall behind again.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. Additive — the connect
        page is engine-owned, so Telegram and Discord both pick up the new look.
      </>
    ),
  },
  {
    version: "0.30.0",
    anchor: "0-30-0",
    date: "June 22, 2026",
    title: "Discord adopts the cold-connect link flow",
    bullets: (
      <>
        <Bullet>
          Discord drops the typed <Code>/verify</Code> 6-digit code.{" "}
          <Code>/link</Code> now emails a one-click confirm link — the same
          cold-connect flow Telegram uses. The bind happens in the browser when
          the user clicks the link, folding <Code>discord_id</Code> + email onto
          one contact and identifying the PostHog person client-side.
        </Bullet>
        <Bullet>
          <Code>@hogsend/plugin-discord</Code> <Code>InteractionDeps</Code> is
          reworked (breaking): the code-flow callbacks (<Code>mintCode</Code>,{" "}
          <Code>sendLinkCode</Code>, <Code>redeemCode</Code>) are replaced by a
          single <Code>requestConfirm</Code> that mints a server-sealed
          cold-connect token and emails the confirm link. The mint throttle
          moved into <Code>mintConfirm</Code> (Redis-INCR, fail-closed).
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. Breaking for consumers
        wiring Discord <Code>/link</Code> — swap the code-flow callbacks for{" "}
        <Code>requestConfirm</Code>; <Code>/verify</Code> and the typed-code
        path are removed.
      </>
    ),
  },
  {
    version: "0.26.0",
    anchor: "0-26-0",
    date: "June 21, 2026",
    title: "Connector DX polish",
    bullets: (
      <>
        <Bullet>
          Readiness now reads the owned heartbeat: connect-info's{" "}
          <Code>ingressSecretConfigured</Code> becomes{" "}
          <Code>legacyIngressSecretConfigured</Code> (deprecated one minor) and{" "}
          <Code>workerOnline</Code> drives it — the inline runtime never uses an
          ingress secret. A runtime that can't take its lease for ~30s (Redis
          down or contended) now logs a loud, actionable error instead of
          silently never connecting.
        </Bullet>
        <Bullet>
          The Discord gateway runtime auto-registers the <Code>/link</Code> and{" "}
          <Code>/verify</Code> slash commands (global, idempotent) the moment
          the socket comes up — no separate{" "}
          <Code>discord:register-commands</Code> step, and it self-heals after a
          token rotation. Exports <Code>registerSlashCommands</Code> +{" "}
          <Code>LINK_VERIFY_COMMANDS</Code>.
        </Bullet>
        <Bullet>
          <Code>hogsend connect discord --status</Code> drops the stale
          ingress-secret line when the worker is online, adds a worker-offline
          hint, and returns a 404-specific error when the consumer's{" "}
          <Code>/secrets</Code> + <Code>/wire</Code> routes aren't mounted.
        </Bullet>
        <Bullet>
          Studio renders the rich gateway card for any{" "}
          <Code>{'transport === "gateway"'}</Code> connector (not the literal{" "}
          <Code>discord</Code> id) — a second Discord bot gets its own card for
          free.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. Additive;{" "}
        <Code>ingressSecretConfigured</Code> stays one more minor as{" "}
        <Code>legacyIngressSecretConfigured</Code>.
      </>
    ),
  },
  {
    version: "0.25.0",
    anchor: "0-25-0",
    date: "June 21, 2026",
    title: "The connector runtime",
    bullets: (
      <>
        <Bullet>
          The Discord gateway socket now runs inside the Hatchet worker — no
          separate service, no <Code>CONNECTOR_INGRESS_SECRET</Code>. A Redis
          leader lease holds exactly one socket per bot token with bounded
          automatic failover, and only the lease-holder writes the liveness
          heartbeat Studio reads, so a stray process cannot fake an online bot.
        </Bullet>
        <Bullet>
          Outbound actions need no socket: <Code>sendConnectorAction(...)</Code>{" "}
          invokes registered <Code>defineConnectorAction</Code>s from a journey
          and works with the inbound gateway off.
        </Bullet>
        <Bullet>
          <Code>@hogsend/plugin-discord</Code> ships{" "}
          <Code>createDiscordRuntime</Code> and <Code>discordActions</Code> (
          <Code>sendChannelMessage</Code>, <Code>broadcastToChannel</Code>,{" "}
          <Code>mentionMembers</Code>, <Code>mentionRole</Code>,{" "}
          <Code>dmMember</Code>); register them via{" "}
          <Code>createHogsendClient</Code> and wire the runtime via{" "}
          <Code>createWorker</Code>.
        </Bullet>
        <Bullet>
          The seam is connector-agnostic: a second connector (Slack) implements
          only <Code>defineConnector</Code> plus a <Code>ConnectorRuntime</Code>{" "}
          factory and reuses lease election, the heartbeat, and the admin
          projection.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. Additive and opt-in —
        activation is automatic when a gateway connector and its bot token are
        present; the standalone Gateway worker from 0.22 remains an escape hatch
        (<Code>CONNECTOR_RUNTIME_HOST=standalone</Code>).
      </>
    ),
  },
  {
    version: "0.24.0",
    anchor: "0-24-0",
    date: "June 21, 2026",
    title: "AI agents on your event stream",
    bullets: (
      <>
        <Bullet>
          <Code>{"ctx.history.events({ userId, limit?, within? })"}</Code> reads
          a user's recent events newest-first (with{" "}
          <Code>RecentEventsOptions</Code> / <Code>RecentEvent</Code> types) —
          the foundation for an agent's context bundle.
        </Bullet>
        <Bullet>
          A freshly scaffolded app ships a working Tier-1 AI onboarding journey
          (<Code>src/agents/</Code>, user context backed by{" "}
          <Code>ctx.history.events()</Code>) and gains <Code>ai</Code> +{" "}
          <Code>@ai-sdk/anthropic</Code>; new docs cover three AI SDK
          integration tiers — inline, tools, and Eve durable human-in-the-loop.
        </Bullet>
        <Bullet>
          BYO webhook-source secrets: a consumer-defined <Code>signature</Code>{" "}
          source now resolves its secret from{" "}
          <Code>process.env[auth.envKey]</Code> when the engine's validated env
          doesn't declare that key — still fail-closed, so an unset secret is a
          401.
        </Bullet>
      </>
    ),
  },
  {
    version: "0.23.0",
    anchor: "0-23-0",
    date: "June 15, 2026",
    title: "One PostHog person per contact",
    bullets: (
      <>
        <Bullet>
          Identity stitching ends one-email-many-persons fragmentation: every
          anonymous id a person carries is absorbed, while still anonymous, into
          one canonical and ever-identified <Code>distinct_id</Code> — the
          Hogsend contact key.
        </Bullet>
        <Bullet>
          Provider-neutral by contract: <Code>mergeIdentities</Code> plus an{" "}
          <Code>identityMerge</Code> capability on{" "}
          <Code>AnalyticsProvider</Code> (<Code>distinctId</Code> survives,{" "}
          <Code>alias</Code> is absorbed). <Code>@hogsend/plugin-posthog</Code>{" "}
          implements it via native <Code>client.alias</Code> in the correct
          direction, and merges are idempotent so a retry never re-aliases.
        </Bullet>
        <Bullet>
          <Code>POST /v1/events</Code> threads an <Code>anonymousId</Code> so
          the contact key can equal the browser's anon id with no merge at all;
          tracked links carry scoped identity tokens redeemed server-side at{" "}
          <Code>/v1/t/identify</Code>, with referral links token-less by
          default.
        </Bullet>
        <Bullet>
          0.23.1 fix: the admin Suppressions All view built no filter and listed
          every contact as suppressed — display only, deliverability was never
          affected (the send-gate blocks on <Code>suppressed</Code> /{" "}
          <Code>unsubscribedAll</Code>). It now restricts to
          genuinely-suppressed recipients.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. Additive and off by
        default — no forced migration.
      </>
    ),
  },
  {
    version: "0.22.0",
    anchor: "0-22-0",
    date: "June 14, 2026",
    title: "Discord: events, identity, and outbound",
    bullets: (
      <>
        <Bullet>
          New <Code>@hogsend/plugin-discord</Code> — both faces of one
          integration under <Code>{'meta.id = "discord"'}</Code>. A long-lived
          Gateway worker (its own process) feeds{" "}
          <Code>discord.message_sent</Code>, <Code>discord.reaction_added</Code>
          , <Code>discord.member_joined</Code>, and{" "}
          <Code>discord.presence_active</Code> into <Code>ingestEvent</Code>,
          stored on the contact; bot, webhook, and system messages and offline
          presence are dropped.
        </Bullet>
        <Bullet>
          <Code>contacts.discord_id</Code> is a new indexed merge key — a fourth
          identity Kind — so a Discord member resolves to the same contact as
          their product activity and email.
        </Bullet>
        <Bullet>
          In-Discord linking: <Code>/link</Code> opens an email modal and mails
          a 6-digit single-use code (15-minute TTL, hashed at rest, rate
          limited); every interaction is ed25519-verified with a ±300s replay
          window, and a <Code>connector_link_codes</Code> table backs the codes.
        </Bullet>
        <Bullet>
          Outbound: <Code>discordDestination</Code> posts one Discord-markdown
          line per lifecycle event to a channel on the durable outbound spine —
          via a no-bot-token incoming webhook (<Code>config.webhookUrl</Code>)
          or bot-REST (<Code>config.channelId</Code>).
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: run <Code>db:migrate</Code> — <Code>contacts.discord_id</Code>{" "}
        and <Code>connector_link_codes</Code> are schema changes. The plugin is
        consumer-mounted; run the Gateway worker as its own process.
      </>
    ),
  },
  {
    version: "0.21.0",
    anchor: "0-21-0",
    date: "June 13, 2026",
    title: "Keyless PostHog connect",
    bullets: (
      <>
        <Bullet>
          <Code>hogsend connect posthog</Code> runs the OAuth handshake first —
          no <Code>phc_</Code> paste needed. It mints and persists the webhook
          secret server-side and grabs the project's public key on the way
          through; the inbound webhook source resolves that secret from the
          credential store at request time, so the loop verifies with no
          redeploy.
        </Bullet>
        <Bullet>
          The OAuth scope set is front-loaded (4 → 13) so later features land
          without forcing a reconnect; <Code>connect-info</Code> surfaces a{" "}
          <Code>scopeGap</Code> to nudge already-connected users to re-consent,
          and the <Code>create-hogsend</Code> scaffold makes the{" "}
          <Code>phc_</Code> paste optional.
        </Bullet>
        <Bullet>
          0.21.1 fix: disconnect now also purges the derived credential row (the
          minted secret and grabbed <Code>phc_</Code>); the inbound source's
          secret cache is busted the moment connect mints a secret, so it is
          enforced immediately instead of after a ~30s recheck.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. Additive; existing{" "}
        <Code>POSTHOG_PERSONAL_API_KEY</Code> setups keep working.
      </>
    ),
  },
  {
    version: "0.20.0",
    anchor: "0-20-0",
    date: "June 12, 2026",
    title: "One command to connect PostHog",
    bullets: (
      <>
        <Bullet>
          <Code>hogsend connect posthog</Code> runs a public-client OAuth flow
          (PKCE S256, loopback callback, no client secret) and discovers the
          OAuth server from your own PostHog host — so the region is always
          right and self-hosted instances degrade to the personal-key path. It
          stores the credential encrypted at rest and provisions the PostHog →
          Hogsend webhook destination idempotently, adopting an existing one
          instead of duplicating.
        </Bullet>
        <Bullet>
          A credential stored at runtime is picked up by the running API and
          worker within ~30 seconds — no restart. Person reads prefer the OAuth
          token and fall back to <Code>POSTHOG_PERSONAL_API_KEY</Code>.
        </Bullet>
        <Bullet>
          It refuses to wire an unauthenticated endpoint: provisioning fails
          when <Code>POSTHOG_WEBHOOK_SECRET</Code> is unset rather than exposing
          one.
        </Bullet>
        <Bullet>
          Contact → person propagation: the <Code>posthog</Code> destination's{" "}
          <Code>syncPersons</Code> turns <Code>contact.created</Code> /{" "}
          <Code>contact.updated</Code> into <Code>$set</Code> captures under the
          contact's canonical key. Only <Code>properties</Code> travel — never
          email or identifiers.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code> and run{" "}
        <Code>db:migrate</Code> (the OAuth connect flow adds a{" "}
        <Code>provider_credentials</Code> table). Everything is additive;
        existing PostHog setups keep working on{" "}
        <Code>POSTHOG_PERSONAL_API_KEY</Code>.
      </>
    ),
  },
  {
    version: "0.19.0",
    anchor: "0-19-0",
    date: "June 12, 2026",
    title: "Provider-neutral analytics, and PostHog reads that work",
    bullets: (
      <>
        <Bullet>
          The <Code>AnalyticsProvider</Code> contract — the analytics sibling of{" "}
          <Code>EmailProvider</Code>, authored via{" "}
          <Code>defineAnalyticsProvider</Code> — lands in{" "}
          <Code>@hogsend/core</Code> with person reads, person writes (
          <Code>set</Code> / <Code>setOnce</Code> / <Code>unset</Code>), and
          capture. The <Code>analytics</Code> client option now mirrors{" "}
          <Code>email</Code>; legacy <Code>PostHogService</Code> inputs are
          adapter-wrapped and keep working.
        </Bullet>
        <Bullet>
          PostHog person reads are fixed — they were silently dead (the
          write-only <Code>phc_</Code> project key sent to the ingestion host on
          a legacy path). Reads now use <Code>POSTHOG_PERSONAL_API_KEY</Code>{" "}
          against the private API host with one-shot project-id discovery.
        </Bullet>
        <Bullet>
          Without the personal key, reads soft-fail to contact-property
          fallbacks — now surfaced once at boot and by{" "}
          <Code>hogsend doctor</Code> instead of silently. Person writes need no
          extra credential; they ride the capture pipeline.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. To turn on person reads,
        set <Code>POSTHOG_PERSONAL_API_KEY</Code> (scoped{" "}
        <Code>person:read</Code>); the scaffold's <Code>env.example</Code>{" "}
        documents the two-credential model.
      </>
    ),
  },
  {
    version: "0.18.0",
    anchor: "0-18-0",
    date: "June 12, 2026",
    title: "Closing the analytics identity loop",
    bullets: (
      <>
        <Bullet>
          <Code>POST /v1/events</Code> now returns <Code>contactKey</Code> — the
          contact's canonical key (
          <Code>external_id ?? anonymous_id ?? id</Code>), the same key
          destinations emit as <Code>userId</Code> and <Code>hs_t</Code> tokens
          resolve to — so a consumer site can <Code>identify()</Code> its
          analytics session against the contact with no PII round-trip.
        </Bullet>
        <Bullet>
          Identity resolution round-trips that key: a key that left the system
          (Hatchet payloads, destination <Code>userId</Code>s, <Code>hs_t</Code>{" "}
          stitches, forwarded PostHog webhooks) always resolves back to the same
          live contact instead of minting a duplicate.
        </Bullet>
      </>
    ),
  },
  {
    version: "0.17.0",
    anchor: "0-17-0",
    date: "June 11, 2026",
    title: "Studio, restyled",
    bullets: (
      <>
        <Bullet>
          Hogsend Studio moves onto the Hogsend design system — the same dark
          surface as the site and docs.
        </Bullet>
        <Bullet>
          0.17.1 fix: the password-reset link now lands on the reset form, not
          the login card. The bare <Code>/studio</Code> redirect was dropping
          better-auth's <Code>?token=…</Code> query string.
        </Bullet>
      </>
    ),
  },
  {
    version: "0.16.0",
    anchor: "0-16-0",
    date: "June 11, 2026",
    title:
      "The where builder, the hosted answer page, and cross-device identity",
    bullets: (
      <>
        <Bullet>
          Journey conditions read like code:{" "}
          <Code>{'where: (b) => b.prop("score").lte(6)'}</Code> on{" "}
          <Code>trigger</Code> and <Code>exitOn</Code>, resolved once at
          definition time to the same plain data — Studio and the admin API are
          unchanged.
        </Bullet>
        <Bullet>
          Semantic links without a landing page:{" "}
          <Code>{"href={HOSTED_ANSWER_HREF}"}</Code> lands answers on an
          engine-hosted page with an optional comment box; comments arrive as{" "}
          <Code>{"<event>.comment"}</Code> events.
        </Bullet>
        <Bullet>
          Cross-device identity, opt-in: <Code>TRACKING_IDENTITY_TOKEN</Code>{" "}
          appends an encrypted one-hour <Code>hs_t</Code> token to tracked
          redirects; the landing site exchanges it at{" "}
          <Code>POST /v1/t/identify</Code> and calls{" "}
          <Code>posthog.identify</Code> — the email click and the web session
          become one person.
        </Bullet>
        <Bullet>
          <Code>ctx.waitForEvent</Code> accepts <Code>lookback</Code> to catch
          answers landing between two waits.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. All three are additive;
        the identity token is off until you set{" "}
        <Code>TRACKING_IDENTITY_TOKEN=true</Code>.
      </>
    ),
  },
  {
    version: "0.14.0",
    anchor: "0-14-0",
    date: "June 11, 2026",
    title: "Semantic links — in-email surveys and one-tap actions",
    bullets: (
      <>
        <Bullet>
          <Code>{"<EmailAction>"}</Code> (new in <Code>@hogsend/email</Code>):
          an anchor whose click fires a real event — an NPS score, a yes/no —
          through the full ingest pipeline. The metadata is lifted into the
          tracked link at send time and never reaches the inbox.
        </Bullet>
        <Bullet>
          First answer per send wins, and confirmation is deferred past a
          30-second window so scanner click-bursts (Outlook SafeLinks,
          Proofpoint) are judged in full — including the scanner's first click —
          before anything is recorded.
        </Bullet>
        <Bullet>
          <Code>ctx.waitForEvent</Code> now returns the matched event's{" "}
          <Code>properties</Code>, so a journey branches on the answer directly;
          an optional <Code>lookback</Code> window closes the gap between
          back-to-back waits.
        </Bullet>
        <Bullet>
          New <Code>email.action</Code> outbound event — the PostHog preset
          captures it under your event name with the answer's properties
          flattened, ready for insights and cohorts.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code> and run{" "}
        <Code>db:migrate</Code> (one additive migration on{" "}
        <Code>tracked_links</Code>). The scaffold ships a{" "}
        <Code>feedback-checkin</Code> example showing the whole loop.
      </>
    ),
  },
  {
    version: "0.11.0",
    anchor: "0-11-0",
    date: "June 9, 2026",
    title: "CLI-first Studio auth",
    bullets: (
      <>
        <Bullet>
          Public Studio sign-up is closed: there is no unauthenticated network
          path that creates a user.
        </Bullet>
        <Bullet>
          First admin via <Code>hogsend studio admin create</Code> (new CLI
          command, with <Code>reset</Code> and <Code>list</Code>) or env
          bootstrap (<Code>STUDIO_ADMIN_EMAIL</Code> /{" "}
          <Code>STUDIO_ADMIN_PASSWORD</Code>) on a zero-user database.
        </Bullet>
        <Bullet>
          Self-service password reset, wired through the engine mailer; tokens
          are single-use with a 15-minute TTL.
        </Bullet>
        <Bullet>
          Auth rate limiting is now shared across replicas via Redis.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. If your Studio admin
        already exists, nothing changes; new deploys set{" "}
        <Code>STUDIO_ADMIN_EMAIL</Code> or run the CLI once.
      </>
    ),
  },
  {
    version: "0.10.0",
    anchor: "0-10-0",
    date: "June 8, 2026",
    title: "Bring your own email provider",
    bullets: (
      <>
        <Bullet>
          Provider-neutral <Code>EmailEvent</Code> webhook contract and an
          HTML-only send wire: the <Code>EmailProvider</Code> is now a dumb
          wire, and rendering, preferences, first-party tracking, and the send
          log stay engine-owned — so everything survives a provider swap.
        </Bullet>
        <Bullet>
          New opt-in <Code>@hogsend/plugin-postmark</Code>: swap with{" "}
          <Code>EMAIL_PROVIDER=postmark</Code>. Resend stays the default.
        </Bullet>
        <Bullet>
          Bounce normalization: auto-suppression now fires only on permanent
          bounces; transient bounces are recorded without suppressing.
        </Bullet>
        <Bullet>
          Provider-native open/click tracking is forced off where possible —
          first-party tracking is the source of truth.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: Postmark deploys need <Code>POSTMARK_SERVER_TOKEN</Code>
        {"; "}Resend deploys change nothing.
      </>
    ),
  },
  {
    version: "0.9.0",
    anchor: "0-9-0",
    date: "June 8, 2026",
    title: "Outbound destinations",
    bullets: (
      <>
        <Bullet>
          The durable outbound webhook spine becomes a fan-out engine:{" "}
          <Code>defineDestination()</Code> plus shipped presets for PostHog,
          Segment, and Slack alongside signed Standard-Webhooks.
        </Bullet>
        <Bullet>
          Every delivery reuses the same retry/backoff/dead-letter machinery.
        </Bullet>
        <Bullet>
          <Code>ENABLE_POSTHOG_DESTINATION</Code> auto-seeds a PostHog endpoint
          on the email funnel so the full lifecycle fans out durably.
        </Bullet>
        <Bullet>
          Breaking: <Code>ctx.posthog.capture</Code> and{" "}
          <Code>ctx.identify</Code> were removed from the journey context —
          PostHog is now one destination among many; the context keeps only
          vendor-neutral orchestration primitives.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade note: open/click events now emit per hit (not first-touch only)
        — size webhook consumers accordingly.
      </>
    ),
  },
  {
    version: "0.8.0",
    anchor: "0-8-0",
    date: "June 7, 2026",
    title: "Outbound webhooks + inbound presets",
    bullets: (
      <>
        <Bullet>
          Signed outbound webhook stream: managed endpoints, per-endpoint
          retry/backoff, dead-letter queue, and a reaper that re-drives due
          retries.
        </Bullet>
        <Bullet>
          Inbound integration presets for Clerk, Supabase, Stripe, and Segment —
          set the secret env var and the signature-verified route auto-enables.
        </Bullet>
        <Bullet>
          <Code>hogsend webhooks</Code> CLI command and{" "}
          <Code>verifyHogsendWebhook</Code> in the client.
        </Bullet>
      </>
    ),
  },
  {
    version: "0.7.0",
    anchor: "0-7-0",
    date: "June 7, 2026",
    title: "The front door: Data API + client SDK",
    bullets: (
      <>
        <Bullet>
          Public <Code>/v1</Code> data plane: contacts, events, transactional
          emails, lists, and campaigns behind an <Code>hsk_</Code> API key.
        </Bullet>
        <Bullet>
          New <Code>@hogsend/client</Code> typed SDK over the data plane.
        </Bullet>
        <Bullet>
          Identity gains email/anonymous keys with a real merge/alias resolver.
        </Bullet>
        <Bullet>
          Lists are code-defined over the preference store; campaigns are
          durable, idempotent, preference-checked broadcasts.
        </Bullet>
      </>
    ),
  },
];

function ChangelogHeader() {
  return (
    <Section divider={false} containerClassName="pt-32 pb-20">
      <Reveal>
        <div className="flex max-w-3xl flex-col items-start">
          <PillBadge>
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-accent"
            />
            Latest release: v{ENGINE_VERSION}
          </PillBadge>
          <h1 className="mt-6 font-display font-medium text-5xl text-white leading-[1.05] tracking-[-0.05em] md:text-[64px]">
            Changelog
          </h1>
          <p className="mt-6 max-w-xl text-base text-white/70 leading-6">
            Every release of the engine, CLI, Studio, and providers. Upgrading
            is <Code>{'pnpm up "@hogsend/*"'}</Code> — never a fork merge.
          </p>
        </div>
      </Reveal>
    </Section>
  );
}

function Entry({ entry, first }: { entry: ChangelogEntry; first: boolean }) {
  return (
    <article
      id={entry.anchor}
      className={cn(
        "grid scroll-mt-[calc(7rem+var(--fd-banner-height,0px))] gap-5 py-12 md:grid-cols-[200px_minmax(0,1fr)] md:gap-12",
        first && "pt-0",
      )}
    >
      <div className="flex flex-row items-center gap-4 self-start md:sticky md:top-28 md:flex-col md:items-start md:gap-3">
        <a
          href={`#${entry.anchor}`}
          className="transition-opacity hover:opacity-80"
        >
          <TagPill accent className="font-mono">
            v{entry.version}
          </TagPill>
        </a>
        <time className="text-sm text-white/40">{entry.date}</time>
      </div>

      <div>
        <h2 className="font-medium text-white text-xl leading-7 tracking-[-0.02em] md:text-2xl md:leading-8">
          {entry.title}
        </h2>
        <ul className="mt-5 flex flex-col gap-3">{entry.bullets}</ul>
        {entry.upgradeNote ? (
          <p className="mt-6 text-sm text-white/50 italic leading-6">
            {entry.upgradeNote}
          </p>
        ) : null}
      </div>
    </article>
  );
}

function Entries() {
  return (
    <Section>
      <div className="divide-y divide-hairline-faint">
        {ENTRIES.map((entry, i) => (
          <Reveal key={entry.version} delay={(i % 3) * 0.08}>
            <Entry entry={entry} first={i === 0} />
          </Reveal>
        ))}
      </div>

      <div className="flex flex-wrap gap-x-10 gap-y-3 border-hairline-faint border-t pt-10">
        <Link
          href="/docs/operating/upgrading"
          className="text-base text-white transition-colors hover:text-white/80"
        >
          Upgrading guide →
        </Link>
        <a
          href={`${GITHUB_URL}/releases`}
          target="_blank"
          rel="noreferrer"
          className="text-base text-white transition-colors hover:text-white/80"
        >
          Full release notes on GitHub →
        </a>
      </div>
    </Section>
  );
}

function ClosingCta() {
  return (
    <Section>
      <Reveal>
        <Card className="relative overflow-hidden p-8 md:p-14">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(70% 120% at 0% 60%, rgba(246, 72, 56, 0.22), transparent 70%)",
            }}
          />

          <div className="relative flex max-w-2xl flex-col items-start">
            <Eyebrow>Stay on the line</Eyebrow>
            <h2 className="mt-4 font-display text-[32px] text-white leading-[1.2] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
              Start on the latest release
            </h2>
            <p className="mt-5 text-base text-white/70 leading-6">
              One scaffold command pulls v{ENGINE_VERSION}; one{" "}
              <Code>pnpm up</Code> keeps you current. Your journeys live in your
              repo, so an upgrade is a dependency bump — never a fork merge.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
              <Button href="/docs/getting-started" icon>
                Start building
              </Button>
              <Button href={RAILWAY_DEPLOY_URL} variant="outline" external>
                Deploy on Railway
              </Button>
              <Link
                href="/docs"
                className="text-sm text-white/60 transition-colors hover:text-white"
              >
                or read the docs first →
              </Link>
            </div>

            <p className="eyebrow mt-6 text-white/40">
              Free to self-host · One scaffold command · No per-contact billing
            </p>

            <div className="mt-8 flex w-full max-w-md items-center justify-between gap-4 rounded-[10px] border border-white/10 bg-[#0a0606] px-4 py-3">
              <code className="overflow-x-auto whitespace-nowrap font-mono text-sm text-white/80">
                {SCAFFOLD_COMMAND}
              </code>
              <CopyButton value={SCAFFOLD_COMMAND} />
            </div>
          </div>
        </Card>
      </Reveal>
    </Section>
  );
}

export default function ChangelogPage() {
  return (
    <main className="flex flex-1 flex-col">
      <ChangelogHeader />
      <Entries />
      <ClosingCta />
    </main>
  );
}
