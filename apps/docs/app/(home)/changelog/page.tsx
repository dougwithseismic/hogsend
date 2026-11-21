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
  keywords: [
    "hogsend changelog",
    "release notes",
    "lifecycle email",
    "email automation",
    "self-hosted",
    "product updates",
    "version history",
    "code-first",
  ],
  alternates: { canonical: "/changelog" },
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
    version: "0.67.1",
    anchor: "0-67-1",
    date: "November 2026",
    title: "A new app type-checks in seconds",
    bullets: (
      <>
        <Bullet>
          <Code>pnpm check-types</Code> in a freshly scaffolded app now checks
          only your code: about 4 seconds and 650 MB, where it previously ran
          out of memory inside the engine before printing anything.
        </Bullet>
        <Bullet>
          The engine ships compiled type declarations, so your editor and{" "}
          <Code>tsc</Code> read its public types instead of re-checking its
          implementation. Journeys, the journey context and your typed template
          keys are exactly as strict as before.
        </Bullet>
        <Bullet>
          Fixed: opening or clicking an email sent outside a journey could
          overwrite that contact&apos;s user id with their email address. The
          event now lands on the contact by email and leaves their id alone.
        </Bullet>
        <Bullet>
          Fixed: when thousands of bucket members expired at once, the
          five-minute check failed every time and nobody left. They now leave in
          batches of 500.
        </Bullet>
        <Bullet>
          Background jobs share one database connection pool instead of opening
          a new one per run, and webhook retries are queued instead of waiting
          on each delivery in turn. Discord and Postmark calls time out after 10
          seconds.
        </Bullet>
        <Bullet>
          Each event for a known contact now takes 10 database queries instead
          of 17, and the preference check on every send is an index lookup
          instead of a full table scan. Bucket conditions that ask whether an
          event happened stop at the first match instead of counting them all.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>, then run{" "}
        <Code>db:migrate</Code>. No code changes. The migration builds five
        indexes and blocks writes to each table while it runs. If{" "}
        <Code>user_events</Code> is large, build them concurrently first (the
        statements are in the release notes); the migration then skips them.
      </>
    ),
  },
  {
    version: "0.67.0",
    anchor: "0-67-0",
    date: "August 18, 2026",
    title: "Referrals, and contact traits in the browser",
    bullets: (
      <>
        <Bullet>
          New <Code>defineReferral()</Code>. A contact shares a link; a visitor
          who arrives through it, identifies and qualifies is recorded as their
          referee. Each stage (touch, bind, qualify, convert) emits a{" "}
          <Code>referral.*</Code> event that can trigger a journey and reach
          your webhook subscribers, and <Code>before*</Code> hooks can veto any
          stage. <Code>getReferralLink()</Code> mints a person&rsquo;s share
          link from inside a journey.
        </Bullet>
        <Bullet>
          Referral reporting is a query, not program config.{" "}
          <Code>GET /v1/referrals/report</Code> takes the attribution model,
          window, depth and per-level weights as request parameters, so you can
          credit multi-level referrals differently without backfilling anything.
          Studio gets observe-only referral views. Payouts are not included.
        </Bullet>
        <Bullet>
          Referrals across the SDKs: <Code>@hogsend/client</Code>{" "}
          <Code>referrals.*</Code>, <Code>@hogsend/js</Code>{" "}
          <Code>referral.link()</Code>, <Code>@hogsend/react</Code>{" "}
          <Code>useReferralLink()</Code>, and the MCP tools{" "}
          <Code>get_referral_report</Code> and <Code>get_referral_tree</Code>.
        </Bullet>
        <Bullet>
          Contact traits you choose to expose are now readable in the browser.
          List the property keys in{" "}
          <Code>
            {"createHogsendClient({ contacts: { publicProperties } })"}
          </Code>{" "}
          and <Code>GET /v1/contacts/me</Code> returns them for the visitor the
          server identified. The default exposes nothing, and a contact key
          supplied by the request is never trusted.
        </Bullet>
        <Bullet>
          <Code>@hogsend/js</Code> gains <Code>hogsend.getContact()</Code> and{" "}
          <Code>hogsend.getTrait(key)</Code>, refreshed on identify and cleared
          on reset; <Code>@hogsend/react</Code> gains <Code>useContact()</Code>{" "}
          and <Code>useTrait(key)</Code>. Augment <Code>ContactTraitsMap</Code>{" "}
          for typed keys.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>, then run{" "}
        <Code>db:migrate</Code> (new referral tables). Additive: nothing reaches
        the browser until you add keys to <Code>publicProperties</Code>.
      </>
    ),
  },
  {
    version: "0.66.0",
    anchor: "0-66-0",
    date: "August 17, 2026",
    title: "A drop-in script tag for the browser SDK",
    bullets: (
      <>
        <Bullet>
          <Code>@hogsend/js</Code> now ships a self-booting script build. Add
          one <Code>&lt;script&gt;</Code> tag with <Code>data-key</Code> (and
          optionally <Code>data-host</Code>, <Code>data-user-id</Code>,{" "}
          <Code>data-user-token</Code>, <Code>data-pageview</Code>) and{" "}
          <Code>window.hogsend</Code> is ready. Calls made before it loads are
          queued and replayed, and a <Code>hogsend:ready</Code> event fires when
          it boots.
        </Bullet>
        <Bullet>
          Your instance serves the file first-party at{" "}
          <Code>GET /hogsend.js</Code>, with an ETag and cache headers. New
          scaffolds include <Code>@hogsend/js</Code>, so the route works out of
          the box; <Code>HOGSEND_JS_PATH</Code> points it at a different build.
        </Bullet>
        <Bullet>
          The script build carries the GTM bridge (
          <Code>data-datalayer=&quot;push&quot;</Code>,{" "}
          <Code>data-datalayer-watch</Code>) and a <Code>hogsend.ui</Code>{" "}
          namespace with plain-JavaScript <Code>banner()</Code> and{" "}
          <Code>toasts()</Code> renderers, also importable as{" "}
          <Code>@hogsend/js/ui</Code>.
        </Bullet>
        <Bullet>
          A bulk contact import no longer starts one journey per merged contact
          that loses a linked account. The <Code>account.unlinked</Code> webhook
          still fires either way.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>. To serve{" "}
        <Code>/hogsend.js</Code> from an existing app, add{" "}
        <Code>@hogsend/js</Code> as a dependency; without it the route returns
        404.
      </>
    ),
  },
  {
    version: "0.65.0",
    anchor: "0-65-0",
    date: "August 14, 2026",
    title: "Account linking for Steam and Twitch",
    bullets: (
      <>
        <Bullet>
          Players can link a Steam or Twitch account to their contact. Steam
          needs no credentials (<Code>STEAM_WEB_API_KEY</Code> is optional);
          Twitch turns on when both <Code>ACCOUNT_LINK_TWITCH_CLIENT_ID</Code>{" "}
          and <Code>ACCOUNT_LINK_TWITCH_CLIENT_SECRET</Code> are set. Any other
          platform is a <Code>defineAccountLink()</Code> call using the{" "}
          <Code>oauth2Link()</Code> or <Code>steamOpenIdLink()</Code> presets.
        </Bullet>
        <Bullet>
          A hosted flow at <Code>/v1/accounts/:provider/start</Code> and{" "}
          <Code>/callback</Code> handles the redirect, signed state, PKCE and a{" "}
          <Code>beforeLink</Code> veto hook. The browser can request a link URL
          itself (<Code>POST /v1/accounts/link-url</Code>) with a user token
          your server minted, so you ship no backend endpoint for it.
        </Bullet>
        <Bullet>
          A data API under the new <Code>accounts</Code> key scope: list links,
          look up who owns a platform account, unlink, bulk import (insert-only,
          never moves an existing link) and mint link URLs. Players can see and
          revoke their own links with <Code>GET /v1/accounts/me</Code> and{" "}
          <Code>POST /v1/accounts/me/revoke</Code>.
        </Bullet>
        <Bullet>
          <Code>account.linked</Code>, <Code>account.unlinked</Code> and{" "}
          <Code>account.link_failed</Code> reach both your webhook subscribers
          and your journeys. Webhook payloads carry the full current state and a{" "}
          <Code>version</Code> sent as a decimal string, so a subscriber can
          discard late or out-of-order deliveries; compare it with{" "}
          <Code>BigInt()</Code>. Imports enroll journeys only with{" "}
          <Code>enrollJourneys: true</Code>.
        </Bullet>
        <Bullet>
          Merging two contacts carries their linked accounts to the survivor,
          and deleting a contact unlinks its accounts.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>, then run{" "}
        <Code>db:migrate</Code> (new linked-accounts table). Account linking
        needs Redis: without <Code>REDIS_URL</Code> its routes return 503.{" "}
        <Code>ConnectorStateIntent.connectorId</Code> is now optional, which
        matters only if your own code reads it.
      </>
    ),
  },
  {
    version: "0.64.0",
    anchor: "0-64-0",
    date: "August 12, 2026",
    title: "Hogsend Email, and replies as events",
    bullets: (
      <>
        <Bullet>
          Hogsend Email, the sending included with Hogsend Cloud.{" "}
          <Code>@hogsend/plugin-hogsend</Code> is an email provider that sends
          over the Hogsend relay, so an instance needs no Resend key and no AWS
          account. A domain verifies with one TXT record instead of three
          CNAMEs. Select it with <Code>EMAIL_PROVIDER=hogsend</Code>.
        </Bullet>
        <Bullet>
          On Hogsend Email, a reply to journey mail arrives as{" "}
          <Code>email.replied</Code>, so a journey can wait on it and branch on
          whether a person answered. Replies are always forwarded to a human
          address, and auto-responders are forwarded but never emitted, so an
          out-of-office cannot advance a journey or start a mail loop.
        </Bullet>
        <Bullet>
          A redelivered bounce notification is now counted once, so it can no
          longer push a deliverable address into suppression. Binary attachments
          sent over the managed path, which were being corrupted, now arrive
          intact.
        </Bullet>
        <Bullet>
          <Code>@hono/zod-openapi</Code> is pinned to 1.4.0: version 1.5.2 ships
          broken type declarations that failed <Code>check-types</Code> in a
          fresh scaffold.
        </Bullet>
        <Bullet>
          Scaffolded apps gain <Code>lint</Code>, <Code>lint:fix</Code> and{" "}
          <Code>format</Code> scripts, so <Code>pnpm lint</Code> runs Biome
          instead of whatever <Code>lint</Code> binary is on your PATH (0.64.1).
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>. Additive: your current
        email provider stays active unless you set{" "}
        <Code>EMAIL_PROVIDER=hogsend</Code>.
      </>
    ),
  },
  {
    version: "0.63.0",
    anchor: "0-63-0",
    date: "August 5, 2026",
    title: "Hogsend Cloud from the command line",
    bullets: (
      <>
        <Bullet>
          <Code>hogsend signup</Code> creates a Hogsend Cloud account, and{" "}
          <Code>hogsend login --email</Code> signs in with an emailed code, no
          browser needed.
        </Bullet>
        <Bullet>
          <Code>hogsend publish</Code> offers to sign you in when you
          aren&rsquo;t, reports each phase while your first publish provisions
          the instance, and with <Code>--no-wait</Code> prints the build id and
          returns.
        </Bullet>
        <Bullet>
          <Code>create-hogsend --cloud</Code> scaffolds an app and takes it to a
          live hosted instance in one command.
        </Bullet>
        <Bullet>
          <Code>@hogsend/mcp</Code> gains five cloud tools: sign up, verify,
          whoami, publish and build status. An admin key is now optional;
          without one the instance tools are hidden and the cloud tools still
          work.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>. No engine changes;
        self-hosted deploys are unaffected.
      </>
    ),
  },
  {
    version: "0.62.0",
    anchor: "0-62-0",
    date: "August 3, 2026",
    title: "One-click CLI login and a deploy template that boots",
    bullets: (
      <>
        <Bullet>
          <Code>hogsend login</Code> opens your browser at the approval page
          with the code filled in, so approving is one click. The code and URL
          are still printed, and <Code>--no-browser</Code> (or a headless or SSH
          session) completes the same flow by hand.
        </Bullet>
        <Bullet>
          Fixed Studio sign-in rate limiting behind Railway&rsquo;s edge. Every
          caller landed in one shared bucket, so ten failed logins by anyone
          locked sign-in for everyone. The limiter now keys on the real client
          IP.
        </Bullet>
        <Bullet>
          Scaffolded apps now start with <Code>node dist/index.js</Code> and{" "}
          <Code>node dist/worker.js</Code> on Railway and migrate with{" "}
          <Code>tsx scripts/migrate.ts</Code>. The previous <Code>pnpm</Code>{" "}
          commands crash-looped on first boot in the production image.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>. If your app was
        scaffolded earlier and deploys to Railway, make the same change to its
        start and pre-deploy commands.
      </>
    ),
  },
  {
    version: "0.61.0",
    anchor: "0-61-0",
    date: "July 29, 2026",
    title: "Merged-away keys resolve to the right person",
    bullets: (
      <>
        <Bullet>
          Security fix. After two contacts merged, a browser (publishable-key)
          caller could present the merged-away key to read that person&rsquo;s
          earlier in-app feed items, or claim the key for itself. Both are
          closed.
        </Bullet>
        <Bullet>
          A merged-away key now resolves to the surviving contact wherever you
          look someone up: <Code>/v1/contacts/find</Code>,{" "}
          <Code>DELETE /v1/contacts</Code> (erasing by an old email erases the
          person it merged into), Studio contact search and detail, bucket
          checks, feed recipients and journey run lookups.
        </Bullet>
        <Bullet>
          Merges no longer rewrite history. Events and sends keep the key they
          were recorded under, and ownership moves with the contact.
        </Bullet>
        <Bullet>
          Tightened: an identified contact&rsquo;s email can no longer be used
          as an anonymous id.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>. No response shapes
        change.
      </>
    ),
  },
  {
    version: "0.60.0",
    anchor: "0-60-0",
    date: "July 29, 2026",
    title: "History follows the contact, not the key",
    bullets: (
      <>
        <Bullet>
          Every read of a person&rsquo;s history now follows the contact rather
          than the key it was written under: journey entry limits and exit
          checks, buckets and campaign audiences, email suppression and
          preferences, Studio and agent views, holdout lift, and attribution and
          revenue. A person whose key changed through a merge keeps one
          continuous history.
        </Bullet>
        <Bullet>
          Identifying a visitor attaches their anonymous history to the contact
          without rewriting it, so each row stays a record of the key it
          happened under.
        </Bullet>
        <Bullet>
          Subjects with no contact record, such as a send to a raw address, are
          still read by their key. That remains a supported state.
        </Bullet>
        <Bullet>
          Studio&rsquo;s events feed shows the contact that owns each event
          instead of guessing, and an event whose owner was deleted shows no
          contact.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>, then run{" "}
        <Code>db:migrate</Code>. On a large deployment, run the three preflight
        uniqueness queries from the release notes first. Breaking for code that
        calls these engine functions directly: <Code>checkEntryLimit</Code>,{" "}
        <Code>checkEmailPreferences</Code>,{" "}
        <Code>readRecipientPreferences</Code>, <Code>getContactRevenue</Code>,{" "}
        <Code>recordAttributionCredits</Code> and{" "}
        <Code>recoverClickContext</Code> now require{" "}
        <Code>contactId: string | null</Code>, and <Code>ConditionContext</Code>{" "}
        requires <Code>contactId</Code>.
      </>
    ),
  },
  {
    version: "0.59.0",
    anchor: "0-59-0",
    date: "July 28, 2026",
    title: "Every history row records its contact",
    bullets: (
      <>
        <Bullet>
          Events, journey states, bucket memberships, email sends and
          preferences now record the contact that owns them, alongside the key
          they were written under. The write is best-effort: a failed lookup
          leaves it empty and never fails the send, ingest or enrollment it
          rides on.
        </Bullet>
        <Bullet>
          Existing rows are filled by a background sweep that is chunked,
          resumable and safe to re-run. It starts at boot and runs again once
          the last sweep is older than 24 hours (
          <Code>CONTACT_ID_BACKFILL_RESWEEP_HOURS</Code>). Force a run with{" "}
          <Code>POST /v1/admin/maintenance/backfill-contact-id</Code> and check
          coverage with <Code>GET /v1/admin/maintenance/contact-id-verify</Code>
          .
        </Bullet>
        <Bullet>
          Nothing reads the new field yet; 0.60 switches history reads onto it.
          Merges carry it to the surviving contact.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>, then run{" "}
        <Code>db:migrate</Code>. The migration builds five indexes and blocks
        writes to each table while it runs. If <Code>user_events</Code> is
        large, build the indexes concurrently while still on 0.58 (the
        statements are in the release notes); the migration then finds them and
        skips the lock.
      </>
    ),
  },
  {
    version: "0.57.0",
    anchor: "0-57-0",
    date: "July 28, 2026",
    title: "Contacts come from identity, not traffic",
    bullets: (
      <>
        <Bullet>
          Anonymous browser traffic no longer creates contact rows. A
          publishable-key event that asserts no identity, an unauthenticated
          arrival, and an in-app feed send to a bare anonymous id are still
          stored, routed to journeys, checked against exits and buckets, and
          mirrored to analytics. They just don&rsquo;t mint a contact. If your
          contacts list was filling with blank rows, that stops.
        </Bullet>
        <Bullet>
          When the visitor identifies, their anonymous events, journey states,
          bucket memberships, sends and preferences are adopted onto the
          contact. Signing in from a second device works the same way: that
          device&rsquo;s anonymous id resolves to the same person and its
          history is adopted.
        </Bullet>
        <Bullet>
          One person can hold many keys. A second email, external id, anonymous
          id or Discord id is recorded and resolves back to the same contact
          instead of creating a duplicate. An external or anonymous id that
          already identifies another contact is refused and logged.
        </Bullet>
        <Bullet>
          Buckets now see email-only and anonymous members. Property criteria
          evaluate against their real data, leave, <Code>maxDwell</Code> and
          dwell passes fire for them, and a campaign targeting a bucket reaches
          every member. So a backlog of old dwell messages doesn&rsquo;t go out,
          the first sweep after upgrading starts their dwell clocks from that
          moment.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>. If you track revenue: an
        anonymous browser event with no <Code>value</Code> no longer fires
        conversions, attribution credits or funnel progress (events with{" "}
        <Code>value</Code> or a <Code>groups</Code> map, secret-key calls and
        identified events still do). <Code>@hogsend/plugin-discord</Code> no
        longer requests the presence intent by default, so{" "}
        <Code>discord.presence_active</Code> stops firing unless you pass
        explicit <Code>intents</Code>. Your own <Code>ingestEvent</Code> calls
        are unchanged.
      </>
    ),
  },
  {
    version: "0.56.0",
    anchor: "0-56-0",
    date: "July 25, 2026",
    title: "Enrichment lands on canonical contact fields",
    bullets: (
      <>
        <Bullet>
          <Code>refineContact()</Code> now writes enrichment to canonical
          contact properties (<Code>title</Code>, <Code>seniority</Code>,{" "}
          <Code>company</Code>, <Code>company_domain</Code>,{" "}
          <Code>company_employees</Code> and others) instead of{" "}
          <Code>refined_*</Code> keys, and records where the data came from in
          one <Code>{"enrichment: { provider, at }"}</Code> object.
        </Bullet>
        <Bullet>
          Enrichment fills only empty fields, so a paid lookup never overwrites
          first-party data you already set. Fit buckets still re-evaluate when a
          lookup returns a value you already had.
        </Bullet>
        <Bullet>
          Lookups cached by 0.54 are converted to the new field names when read.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>. Breaking if you read{" "}
        <Code>refined_*</Code> properties: point bucket criteria and conditions
        at the canonical names.
      </>
    ),
  },
  {
    version: "0.55.0",
    anchor: "0-55-0",
    date: "July 25, 2026",
    title: "Opt-in provider plugins that load in every app",
    bullets: (
      <>
        <Bullet>
          The Apollo, Postmark and Twilio presets now work in scaffolded apps.
          Before, setting <Code>APOLLO_API_KEY</Code>,{" "}
          <Code>POSTMARK_SERVER_TOKEN</Code> or the Twilio credentials
          registered nothing while the deploy looked healthy.
        </Bullet>
        <Bullet>
          <Code>create-hogsend --with apollo|postmark|twilio</Code> (repeatable
          or comma-separated, plus an interactive picker) adds the plugin as a
          direct dependency and puts its credentials in{" "}
          <Code>.env.example</Code>.
        </Bullet>
        <Bullet>
          Boot logs now say whether a plugin is not installed, failed to load,
          or is missing an export, instead of reporting every failure as
          &ldquo;not installed&rdquo;.
        </Bullet>
        <Bullet>
          Bucket enter and leave events no longer create duplicate contacts for
          visitors who were never identified.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>. If you set any of these
        credentials, add the matching package as a direct dependency of your app
        (for example <Code>pnpm add @hogsend/plugin-apollo</Code>); the
        engine&rsquo;s optional dependency is not enough.
      </>
    ),
  },
  {
    version: "0.54.0",
    anchor: "0-54-0",
    date: "July 25, 2026",
    title: "Contact enrichment",
    bullets: (
      <>
        <Bullet>
          New <Code>refineContact()</Code> pulls person and company data for a
          known contact from an enrichment provider and writes it to the
          contact, so a bucket built from behaviour can also be qualified by
          fit. It is a standalone import like <Code>sendEmail()</Code> and never
          throws: every failure comes back as a status.
        </Bullet>
        <Bullet>
          Enrichment providers are bring-your-own, authored with{" "}
          <Code>defineEnrichmentProvider()</Code>.{" "}
          <Code>@hogsend/plugin-apollo</Code> is the reference implementation.
        </Bullet>
        <Bullet>
          Spend controls ship with it. Every lookup is cached per provider and
          key, misses included, and <Code>ENRICHMENT_MONTHLY_LOOKUPS</Code> is a
          hard monthly cap on vendor calls that fails closed.
        </Bullet>
        <Bullet>
          <Code>GET /v1/admin/contacts</Code> can sort by a numeric contact
          property (<Code>orderBy=property</Code>), which turns a bucket into a
          ranked list. A new <Code>contact.refined</Code> webhook event fires on
          each new refinement; a cache hit emits nothing.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>.{" "}
        <Code>ENRICHMENT_MONTHLY_LOOKUPS</Code> defaults to <Code>0</Code>,
        which means uncapped, so set it per environment before turning on a paid
        provider.
      </>
    ),
  },
  {
    version: "0.53.0",
    anchor: "0-53-0",
    date: "July 21, 2026",
    title: "Managed links from the client SDK",
    bullets: (
      <>
        <Bullet>
          <Code>@hogsend/client</Code> gains a <Code>links</Code> resource:{" "}
          <Code>create</Code>, <Code>get</Code>, <Code>list</Code>,{" "}
          <Code>update</Code>, <Code>archive</Code>, <Code>qr</Code> and{" "}
          <Code>qrUrl</Code>.
        </Bullet>
        <Bullet>
          Link minting is idempotent. Pass an <Code>idempotencyKey</Code> to
          dedupe links without a slug, and re-minting an existing slug with
          compatible settings returns the existing link instead of a 409. Links
          also accept a <Code>source</Code> field.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>. Additive.
      </>
    ),
  },
  {
    version: "0.52.0",
    anchor: "0-52-0",
    date: "July 21, 2026",
    title: "Group-scoped waits",
    bullets: (
      <>
        <Bullet>
          <Code>ctx.waitForEvent</Code> and <Code>ctx.history.hasEvent</Code>{" "}
          take a <Code>group</Code> option, so a person&rsquo;s journey can wait
          until anyone in their account or team fires an event. The group comes
          from an explicit <Code>{"{ type, key }"}</Code>, the trigger
          event&rsquo;s groups, or the user&rsquo;s only membership; an
          ambiguous case throws <Code>GroupScopeUnresolvableError</Code> rather
          than guessing.
        </Bullet>
        <Bullet>
          Wait results now include <Code>actorUserId</Code>, the user who fired
          the matching event, on every hit, including ordinary user-scoped
          waits.
        </Bullet>
        <Bullet>
          A filtered wait records its outcome once and replays it, so a redeploy
          after the wait resolved can no longer flip the run onto the timeout
          branch. In 0.52.1, replaying a run after a crash no longer fails when
          a resolved filtered or group wait is followed by more steps.
        </Bullet>
        <Bullet>
          <Code>@hogsend/testing</Code> simulates group scope (
          <Code>triggerGroups</Code>), and new scaffolds include a typed{" "}
          <Code>groups.d.ts</Code> plus a group-wait example journey with tests.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>. Tests that compare wait
        results by exact equality will see the new <Code>actorUserId</Code>{" "}
        field, and reusing one wait label twice in a run now throws. Group waits
        are code-first only; Journey Blueprints don&rsquo;t have the option yet.
      </>
    ),
  },
  {
    version: "0.51.0",
    anchor: "0-51-0",
    date: "July 20, 2026",
    title: "Searchable Studio pickers and a real suppressed status",
    bullets: (
      <>
        <Bullet>
          Studio replaces free-typed identifiers with searchable two-pane
          pickers: events (with the journeys that use them and first and last
          seen), people (server-searched, with a profile card), sources, group
          types, templates and journeys. You can still type a value that
          isn&rsquo;t in the list.
        </Bullet>
        <Bullet>
          Sends blocked by suppression or test mode get their own{" "}
          <Code>suppressed</Code> status instead of <Code>failed</Code>, so{" "}
          <Code>failed</Code> now means a real dispatch failure. Studio shows it
          as a neutral chip and can filter by it. Frequency caps and journey
          min-gap checks ignore suppressed sends, as they already did failed
          ones.
        </Bullet>
        <Bullet>
          Campaign stats gain a <Code>skipped</Code> count for suppressed sends
          and now attribute every send to its campaign directly, so nothing
          blocked goes uncounted.
        </Bullet>
        <Bullet>
          <Code>hogsend upgrade</Code> no longer aborts on pnpm 11&rsquo;s
          interactive prompt when run with <Code>--json</Code>,{" "}
          <Code>--yes</Code> or without a terminal.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>, then run{" "}
        <Code>db:migrate</Code> (adds the <Code>suppressed</Code> status). Sends
        recorded before this version keep their old <Code>failed</Code> status.
      </>
    ),
  },
  {
    version: "0.50.0",
    anchor: "0-50-0",
    date: "July 18, 2026",
    title: "Groups, in-journey A/B tests, and journey unit tests",
    bullets: (
      <>
        <Bullet>
          Groups: track accounts, teams or companies by{" "}
          <Code>(groupType, groupKey)</Code>, each with its own properties and
          members, with or without an analytics provider. Writes and reads use a
          secret key (<Code>/v1/groups</Code>, <Code>@hogsend/client</Code>{" "}
          <Code>groups.*</Code>, Segment <Code>group</Code> calls); browsers can
          only attach events to a group, with <Code>hogsend.group()</Code> or{" "}
          <Code>useGroup()</Code>. With PostHog configured, associations forward
          as <Code>$groups</Code>. New <Code>group.*</Code> webhook events and
          Studio views.
        </Bullet>
        <Bullet>
          <Code>ctx.variant(key, arms)</Code> runs a deterministic, equal-split
          A/B test inside a journey. Each contact&rsquo;s arm is recorded once
          and replayed unchanged, even if a later deploy changes the arms.
        </Bullet>
        <Bullet>
          New <Code>@hogsend/testing</Code>: run journeys in-process against
          virtual time, scripted events and a captured mailbox, with scenario
          tables and optional Vitest matchers. New scaffolds include a tested
          example.
        </Bullet>
        <Bullet>
          <Code>@hogsend/js</Code> gains a two-way <Code>window.dataLayer</Code>{" "}
          bridge, off by default: pipe an allowlist of existing GTM events into
          Hogsend, and mirror Hogsend events back out as{" "}
          <Code>hogsend.&lt;name&gt;</Code>. <Code>client.setUserToken()</Code>{" "}
          applies a late-arriving user token without remounting the React
          provider.
        </Bullet>
        <Bullet>
          New <Code>@hogsend/video</Code>: normalized watch-depth events from
          YouTube, Vimeo and HTML5 video, sent to Hogsend, PostHog, GA4, Segment
          or your own emitter.
        </Bullet>
        <Bullet>
          Also new: a weekly <Code>impact.digest</Code> webhook event covering
          newly shipped journey versions and holdout results that cross a
          win-probability threshold; an Intercom/Fin webhook preset that turns
          conversations into <Code>support.*</Code> events (set{" "}
          <Code>INTERCOM_CLIENT_SECRET</Code>); and an optional{" "}
          <Code>BASE_CURRENCY</Code> lens that adds converted figures to group
          revenue views.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>, then run{" "}
        <Code>db:migrate</Code> (new group tables). Additive.{" "}
        <Code>ctx.history.email</Code> and <Code>ctx.history.sms</Code> no
        longer count attempts that never reached a provider. Journeys stay
        person-scoped; group-level journeys are not part of this release.
      </>
    ),
  },
  {
    version: "0.46.0",
    anchor: "0-46-0",
    date: "July 14, 2026",
    title: "Scaffold to running with zero prompts",
    bullets: (
      <>
        <Bullet>
          The scaffold, bootstrap and run path works with no prompts, so an
          agent or CI job can drive it. New flags <Code>--admin-email</Code> and{" "}
          <Code>--admin-password</Code> preset the first Studio admin (created
          on first boot), and <Code>--posthog</Code> records PostHog intent
          without a browser.
        </Bullet>
        <Bullet>
          Fixed: setting <Code>STUDIO_ADMIN_EMAIL</Code> now creates the first
          admin at boot, as documented. The template never made the call.
        </Bullet>
        <Bullet>
          Every scaffold&rsquo;s <Code>CLAUDE.md</Code> includes a headless
          &ldquo;zero to running&rdquo; runbook. In a non-interactive run,
          bootstrap failures print their full cause, and bootstrap moves the
          app&rsquo;s own port when 3002 is busy.
        </Bullet>
        <Bullet>
          Pass <Code>{"journeyConstants: { templates, events }"}</Code> to{" "}
          <Code>createHogsendClient</Code> and Studio&rsquo;s journey graph
          resolves <Code>Templates.X</Code> and <Code>Events.X</Code> to their
          real values, so email steps preview exactly and wait nodes show live
          counts. New scaffolds wire it by default.
        </Bullet>
        <Bullet>
          Fixes: the Studio events feed no longer shows an event twice when two
          contacts share a key, and in 0.46.1 the Setup checklist&rsquo;s docs
          links no longer 404.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>. Apps scaffolded earlier
        that rely on <Code>STUDIO_ADMIN_EMAIL</Code>: add{" "}
        <Code>{"await bootstrapAdminFromEnv({ client });"}</Code> to{" "}
        <Code>src/index.ts</Code>, just before{" "}
        <Code>bootstrapApiKeyFromEnv</Code>.
      </>
    ),
  },
  {
    version: "0.45.0",
    anchor: "0-45-0",
    date: "July 14, 2026",
    title: "A first run that works, and PostHog without pasted keys",
    bullets: (
      <>
        <Bullet>
          The engine boots without email credentials. With no provider
          configured, Studio, ingest and non-email journeys all work and each
          send fails with a clear message, so new scaffolds no longer need a
          placeholder <Code>RESEND_API_KEY</Code>. A provider you name
          explicitly still fails at boot if it isn&rsquo;t registered.
        </Bullet>
        <Bullet>
          <Code>hogsend connect posthog</Code> is now the whole PostHog setup.
          The project key it discovers is stored and activated at boot, so
          capture works without setting <Code>POSTHOG_API_KEY</Code>. If no
          admin key is configured locally, the CLI offers to mint one into{" "}
          <Code>.env</Code>.
        </Bullet>
        <Bullet>
          First-run fixes in <Code>create-hogsend</Code>: installs work on pnpm
          11, apps in a folder with a space in its path no longer skip engine
          migrations silently, and bootstrap checks that migrations finished and
          exits non-zero with a summary when any step fails.
        </Bullet>
        <Bullet>
          Bootstrap mints an admin key alongside the ingest key and can run the
          PostHog connect flow as its last step. The scaffold&rsquo;s PostHog
          question becomes &ldquo;Where will events come from?&rdquo;, with your
          own app code selected by default.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>. Additive.
      </>
    ),
  },
  {
    version: "0.44.0",
    anchor: "0-44-0",
    date: "July 13, 2026",
    title: "Revenue, deal funnels, and multi-model attribution",
    bullets: (
      <>
        <Bullet>
          <Code>value</Code> and <Code>currency</Code> are first-class columns
          on every event now — a real money column, not a property convention.
          Rollups are per-currency and never cross-summed; malformed money is
          dropped. <Code>@hogsend/js</Code> auto-captures the ad click on
          landing (<Code>fbclid</Code>, <Code>gclid</Code> and nine more, or any{" "}
          <Code>utm_*</Code>) as a <Code>campaign.arrived</Code> touchpoint,
          persisted last-touch.
        </Bullet>
        <Bullet>
          New <Code>defineFunnel</Code> — event-native deal funnels. Ordered
          stages advance on your own events, with money milestones:{" "}
          <Code>milestone: &ldquo;quoted&rdquo;</Code> mints{" "}
          <Code>deal.quoted</Code> and <Code>milestone: &ldquo;won&rdquo;</Code>{" "}
          mints <Code>deal.sold</Code> — stable names across any ladder, once
          per deal. A <Code>crmPipeline</Code> binding composes a CRM leg; no
          CRM required, and one deployment runs many funnels.
        </Bullet>
        <Bullet>
          New <Code>defineConversion</Code> — declares which events count, what
          they&rsquo;re worth (event / fixed / property), and where they
          dispatch, behind a forged-value guard that rejects browser-tier values
          by default. A zero-config <Code>revenue</Code> conversion is
          auto-seeded. <Code>@hogsend/plugin-meta-capi</Code> is the first
          native destination — hashed identifiers, the real stored click, and a
          deterministic <Code>event_id</Code> across retries.
        </Bullet>
        <Bullet>
          New <Code>@hogsend/attribution</Code> engine. Every conversion writes
          a credit ledger under all eight models at fire time (first, last,
          last-non-direct, linear, time-decay, position-U, position-W, blended),
          so switching models in reporting is instant and historical — never
          re-derived. Studio&rsquo;s Impact tab keeps three numbers separate:
          Attributed (fractional, sums to the real total), Influenced (reach),
          and Incremental (holdout-backed lift).{" "}
          <Code>hogsend attribution backfill</Code> recomputes history.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code> (deps + vendored skills).
        Additive — attribution accrues automatically once you capture arrivals
        and fire valued events; there is no config key to set.
      </>
    ),
  },
  {
    version: "0.43.0",
    anchor: "0-43-0",
    date: "July 11, 2026",
    title: "First-class SMS channel",
    bullets: (
      <>
        <Bullet>
          SMS mirrors the email architecture end to end. A provider-neutral{" "}
          <Code>SmsProvider</Code> contract (<Code>defineSmsProvider</Code>), a
          new <Code>@hogsend/sms</Code> package (templates authored as React,
          rendered to plain text, with a GSM-7/UCS-2 segment counter), and{" "}
          <Code>@hogsend/plugin-twilio</Code> as the reference wire. Opt-in:
          with no provider configured the SMS service is an inert stub, so
          existing deploys are unaffected.
        </Bullet>
        <Bullet>
          Explicit consent by default (TCPA). The <Code>sms</Code> channel is{" "}
          <Code>defaultOptIn: false</Code> — a marketing text needs an explicit
          grant or an inbound <Code>START</Code>, else it fails closed.
          Transactional sends bypass only the consent and topic gates, never the
          phone STOP list. A genuine grant emits the new{" "}
          <Code>contact.subscribed</Code> event; full STOP/START/HELP handling
          ships in the box.
        </Bullet>
        <Bullet>
          First-party SMS link tracking, on by default. Bare URLs become{" "}
          <Code>/s/&lt;code&gt;</Code> short links riding the same click spine
          as email — per-hit <Code>sms.clicked</Code>, first-touch{" "}
          <Code>clicked_at</Code>, and an <Code>sms.link_clicked</Code> bus
          event your journeys can wait on.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>. SMS is entirely opt-in —
        add a Twilio provider and a sender to turn it on; leave them out and
        nothing changes.
      </>
    ),
  },
  {
    version: "0.42.0",
    anchor: "0-42-0",
    date: "July 11, 2026",
    title: "Journey Blueprints — hardened, and promote-to-code",
    bullets: (
      <>
        <Bullet>
          New <Code>hogsend blueprints promote</Code> turns a JSON Journey
          Blueprint into a real code-first <Code>defineJourney</Code> file on a
          fresh branch — faithful to the interpreter, with{" "}
          <Code>ctx.exit()</Code>, idempotency labels, and frozen
          non-deterministic decisions. It never commits or pushes.
        </Bullet>
        <Bullet>
          New <Code>ctx.exit(reason?)</Code> journey primitive — terminate an
          enrollment as <Code>exited</Code> (no <Code>journey:completed</Code>{" "}
          or <Code>journey:failed</Code>). The blueprint interpreter and
          promoted code share the one mechanism.
        </Bullet>
        <Bullet>
          Save-path hardening across the interpreter, save path, and Studio:
          reserved engine namespaces are rejected at save time, an{" "}
          <Code>entryPeriod</Code> must be a positive duration, and enable /
          update / promote races are closed with guarded conditional writes and
          an advisory lock so a graph edit can&rsquo;t desync a suspended
          run&rsquo;s replay.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>pnpm dlx hogsend upgrade</Code>. Additive; the new
        save-time validation only rejects blueprints that were already unsafe.
      </>
    ),
  },
  {
    version: "0.41.0",
    anchor: "0-41-0",
    date: "July 10, 2026",
    title: "Channel preferences",
    bullets: (
      <>
        <Bullet>
          Delivery channels are now opt-out lists. The engine auto-registers a{" "}
          <Code>kind: &ldquo;channel&rdquo;</Code> list for the in-app feed (
          <Code>in_app</Code>, always) and one per member-directed connector (
          <Code>telegram</Code> always in the dogfood, <Code>discord</Code> when
          configured). They live in the same{" "}
          <Code>email_preferences.categories</Code> namespace and are managed
          with the usual <Code>POST /v1/lists/:id/(un)subscribe</Code>. A{" "}
          <Code>defineList</Code> id may not collide with a channel id, and{" "}
          <Code>in_app</Code> is reserved — both throw at boot.
        </Bullet>
        <Bullet>
          Member-directed connector actions are preference-gated automatically.
          Discord <Code>dmMember</Code> and Telegram <Code>dm</Code> /{" "}
          <Code>sendMessage</Code> skip with a typed{" "}
          <Code>ConnectorActionSkipped</Code> (guarded by{" "}
          <Code>isConnectorActionSkipped</Code>) when the resolved contact has
          globally unsubscribed or opted out of that connector&rsquo;s channel.
          Ops actions (roles, broadcasts, channel messages) are never gated, and
          a send with no resolvable contact proceeds. The skip verdict is
          replay-stable. The in-app feed now enforces <Code>in_app</Code> the
          same way, through an aggregated multi-row preference read.
        </Bullet>
        <Bullet>
          <Code>defineJourney</Code> meta gains an optional{" "}
          <Code>category</Code> that stamps every one of the journey&rsquo;s{" "}
          <Code>sendEmail</Code> sends (overriding the template&rsquo;s
          category, like the built-in <Code>journey</Code> default). It is
          boot-validated fail-closed: unknown, channel-list, or excluded-opt-in
          categories throw; excluded opt-out warns. Campaign audiences reject
          channel lists too.
        </Bullet>
        <Bullet>
          The SDK and Studio caught up. <Code>GET /v1/lists</Code> items carry{" "}
          <Code>kind</Code>; a new <Code>POST /v1/lists/preferences</Code>{" "}
          writes the account-wide <Code>unsubscribedAll</Code> master toggle
          behind the same identity gate as list writes. <Code>@hogsend/js</Code>{" "}
          adds <Code>ListSummary.kind</Code>,{" "}
          <Code>preferences().setUnsubscribedAll()</Code>, and the exported{" "}
          <Code>ALL_EMAILS_CATEGORY</Code> (<Code>&ldquo;$all&rdquo;</Code>)
          sentinel; <Code>@hogsend/react</Code>&rsquo;s{" "}
          <Code>&lt;PreferenceCenter&gt;</Code> auto-sections into Channels
          (with a synthetic Email master row) and Topics, with new{" "}
          <Code>layout</Code> / <Code>emailToggle</Code> /{" "}
          <Code>sectionLabels</Code> props. Studio&rsquo;s contact drawer gains
          per-channel and per-topic toggles.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. Additive — an older
        engine emits no <Code>kind</Code>, so the preference center renders flat
        exactly as before. Refresh the vendored skills with{" "}
        <Code>pnpm dlx hogsend skills add --force</Code>.
      </>
    ),
  },
  {
    version: "0.39.0",
    anchor: "0-39-0",
    date: "July 9, 2026",
    title:
      "Studio journey flow, typed template keys, and boot-time config guards",
    bullets: (
      <>
        <Bullet>
          Studio can now render a journey&rsquo;s control flow as a graph. A
          typed node/edge journey-graph IR lands in <Code>@hogsend/core</Code>.
          The engine ships an AST-based extractor, per-stage{" "}
          <Code>journey_logs</Code> transitions for funnel metrics, and an
          &ldquo;open in editor&rdquo; source-location affordance. The Studio
          view is a dagre-laid-out flow with decision nodes, forks, and inline
          email preview, plus a drop-off funnel, an AI-share button,
          open-in-IDE, and Mermaid / image export.
        </Bullet>
        <Bullet>
          The build now fails on an unregistered journey email template key.{" "}
          <Code>sendEmail</Code>&rsquo;s <Code>template</Code> is typed against
          the registered-key union (<Code>TemplateName</Code>) instead of{" "}
          <Code>string</Code>, so a journey pointing at a template that was
          never registered is a compile error at every send site. As a runtime
          backstop, <Code>@hogsend/email</Code>&rsquo;s <Code>getTemplate</Code>{" "}
          throws a loud error naming the bad key and the registered ones.
        </Bullet>
        <Bullet>
          Config ids are boot-validated — misconfiguration fails loud instead of
          silently mis-behaving. <Code>ANALYTICS_PROVIDER</Code> throws at boot
          when the selected id resolves to no registered provider (symmetric
          with <Code>EMAIL_PROVIDER</Code>); <Code>ENABLED_JOURNEYS</Code>{" "}
          throws on an id that matches no journey, with a did-you-mean;{" "}
          <Code>JourneyRegistry.register()</Code> throws on a duplicate id
          instead of silently double-routing; and every template&rsquo;s{" "}
          <Code>category</Code> is checked against the email-list namespace —
          unknown throws, and excluding an opt-in list via{" "}
          <Code>ENABLED_LISTS</Code> throws (it would un-gate consent at send
          time). <Code>POST /v1/emails</Code> rejects an unknown category too.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. Additive at runtime, but
        stricter on purpose: a misconfigured <Code>ANALYTICS_PROVIDER</Code>,{" "}
        <Code>ENABLED_JOURNEYS</Code> id, or template <Code>category</Code> that
        used to fail quietly now throws at boot, and a journey referencing an
        unregistered template is now a compile error.
      </>
    ),
  },
  {
    version: "0.38.0",
    anchor: "0-38-0",
    date: "July 6, 2026",
    title: "Bulk suppression import + a migration importer CLI",
    bullets: (
      <>
        <Bullet>
          <Code>POST /v1/admin/suppressions/import</Code> (with a status-poll
          twin): async bulk import of unsubscribes, bounces, and spam complaints
          via an <Code>import-suppressions</Code> Hatchet task (CSV or JSON,
          batches of 500). Rows map onto the existing{" "}
          <Code>email_preferences</Code> semantics — no schema change — through
          the single <Code>upsertEmailPreference</Code> choke point, which gains
          an <Code>emitOutbound</Code> opt-out so a historical import
          doesn&rsquo;t fan out a <Code>contact.unsubscribed</Code> event per
          row.
        </Bullet>
        <Bullet>
          New <Code>hogsend import</Code> CLI migrates contacts <em>and</em>{" "}
          suppression state into a running instance over the admin API:{" "}
          <Code>hogsend import csv</Code> for generic header CSVs,{" "}
          <Code>hogsend import loops</Code> for the Loops dashboard export
          (typed properties + per-contact suppression lookups), and{" "}
          <Code>hogsend import customerio</Code> for the Customer.io async
          people export plus its ESP bounce/spam lists. Source requests are
          rate-limited with retry-on-429 backoff and job polling aborts loudly
          rather than hanging.
        </Bullet>
        <Bullet>
          The send-time suppression gate now aggregates per address:{" "}
          <Code>checkSuppression</Code> reads every{" "}
          <Code>email_preferences</Code> row for the recipient (the PK is{" "}
          <Code>(user_id, email)</Code>), so a suppression imported before the
          contact existed still blocks the send.
        </Bullet>
        <Bullet>
          Long-running journeys hardened against silent stalls. A multi-step{" "}
          <Code>once</Code> journey used to strand in <Code>waiting</Code> after
          its first durable wait — on an eviction-capable engine the entry-limit
          guard re-ran on replay-from-top <em>before</em> the run-id recovery
          lookup and short-circuited with <Code>already_entered_once</Code>. The
          recovery lookup now runs first (0.38.1), and 0.38.2 adds a 15-minute{" "}
          <Code>scheduleTimeout</Code> so a resume survives a redeploy
          saturating worker slots, plus a timezone-lookup fallback so a
          transient DB blip can&rsquo;t strand the row.
        </Bullet>
        <Bullet>
          Consent-gated storage seam: <Code>@hogsend/js</Code> exports its
          storage adapters (<Code>createMemoryStorage</Code> /{" "}
          <Code>createLocalStorage</Code>) and <Code>HogsendProvider</Code>{" "}
          accepts a <Code>storage</Code> prop, so a host app can keep the SDK
          from persisting <Code>hs_anon_id</Code> until the visitor grants
          storage consent.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. Additive — no forced
        migration.
      </>
    ),
  },
  {
    version: "0.37.0",
    anchor: "0-37-0",
    date: "June 26, 2026",
    title: "In-app component kit",
    bullets: (
      <>
        <Bullet>
          A survey / rating primitive: a surface-neutral{" "}
          <Code>{"<Survey>"}</Code> email component and an in-app survey feed
          block, plus <Code>sendSurvey()</Code>. Answers ride the existing event
          spine (no new write path) and are readable from journeys via{" "}
          <Code>ctx.waitForEvent</Code>. A read-only{" "}
          <Code>GET /v1/admin/reporting/breakdown</Code> aggregates any event by
          a property value — count, average, optional NPS.
        </Bullet>
        <Bullet>
          <Code>{"<PreferenceCenter>"}</Code> — per-category × per-channel
          notification preferences over <Code>usePreferences</Code>, bundleable
          into <Code>{"<FeedPopover>"}</Code> as a tab, backed by a new
          read-only <Code>GET /v1/lists</Code> catalog.
        </Bullet>
        <Bullet>
          Swipe-to-archive is now a first-class affordance in{" "}
          <Code>@hogsend/react</Code> (pointer / touch swipe plus an accessible
          archive button), the toast gains a polished default skin and
          first-class custom rendering (<Code>renderToast</Code>), and the
          notification bell badge <Code>box-sizing</Code> is fixed so the unread
          count renders as a solid pinned circle under any host reset.
        </Bullet>
        <Bullet>
          The feed is responsive (0.37.1–0.37.3): it sets its own type baseline
          so items don&rsquo;t balloon to the host font-size, the{" "}
          <Code>scale</Code> / <Code>nps</Code> row shrinks to fit instead of
          wrapping in a narrow (380px bell) popover, long titles and bodies
          clamp to a token-driven N-line ellipsis, and new items fade + lift in
          behind a <Code>prefers-reduced-motion</Code> gate.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. <Code>@hogsend/js</Code>{" "}
        / <Code>@hogsend/react</Code> are opt-in — not{" "}
        <Code>create-hogsend</Code> scaffold defaults.
      </>
    ),
  },
  {
    version: "0.36.0",
    anchor: "0-36-0",
    date: "June 25, 2026",
    title: "The client-side layer",
    bullets: (
      <>
        <Bullet>
          <Code>@hogsend/js</Code> — a zero-dependency browser core: identity,
          capture, preferences, an in-app feed, banners, toasts, and a reactive
          store.
        </Bullet>
        <Bullet>
          <Code>@hogsend/react</Code> — a provider, hooks, and the{" "}
          <Code>NotificationBell</Code> / <Code>FeedPopover</Code> /{" "}
          <Code>NotificationFeed</Code> / <Code>Banner</Code> /{" "}
          <Code>Toast</Code> components with a <Code>{"--hs-*"}</Code> themed
          override surface.
        </Bullet>
        <Bullet>
          The engine pieces that power them: publishable-key (<Code>pk_</Code>)
          browser-ingest auth (per-key origin allowlist, reflective CORS, an{" "}
          <Code>allowed_origins</Code> migration); the feed backend (
          <Code>feed_items</Code> table, <Code>sendFeedItem()</Code> +{" "}
          <Code>send-feed</Code> workflow, recipient-scoped{" "}
          <Code>/v1/feed/*</Code> routes with SSE fan-out);{" "}
          <Code>sendBanner()</Code>, and the <Code>generateUserToken</Code> mint
          helper for identified browser sessions. Every client interaction is a
          first-party <Code>inapp.*</Code> / <Code>banner.*</Code> event through
          the ingest spine, so it can trigger a journey and fan to PostHog.
        </Bullet>
        <Bullet>
          0.36.1 fix: a server-side re-ingest keyed by a contact&rsquo;s own
          canonical key (its <Code>anonymous_id</Code>) minted a phantom
          &ldquo;identified&rdquo; twin that 403&rsquo;d the visitor out of
          their own feed (<Code>anonymousId is not addressable</Code>).
          Engine-internal re-emits now carry the unforgeable contact row id and
          pin to that exact row — never value-resolving, never minting; the
          public routes can&rsquo;t supply it, so the anti-impersonation
          boundary is unchanged.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. <Code>@hogsend/js</Code>{" "}
        / <Code>@hogsend/react</Code> ride the engine version line but are
        opt-in.
      </>
    ),
  },
  {
    version: "0.35.0",
    anchor: "0-35-0",
    date: "June 25, 2026",
    title: "A co-working AI agent in Studio",
    bullets: (
      <>
        <Bullet>
          An in-Studio co-working agent: a bottom-right chat panel that reads
          the live instance (contacts, events, journeys, buckets, sends) and can
          act through the existing data plane — every write gated behind a
          human-in-the-loop confirmation.
        </Bullet>
        <Bullet>
          Engine: a streaming <Code>POST /v1/admin/agent/chat</Code> (Vercel AI
          SDK + OpenRouter, default <Code>z-ai/glm-5.2</Code>) under the admin
          auth / rate-limit / audit stack; the OpenRouter key never leaves the
          server. Read tools auto-run; write tools mint a single-use, encrypted,
          Redis-burned proposal token that only{" "}
          <Code>POST /v1/admin/agent/confirm</Code> can execute (idempotent,
          audited).
        </Bullet>
        <Bullet>
          Studio: a launcher → slide-over drawer, multi-chat, markdown
          rendering, tool-call cards, a tier-driven confirmation card, and
          per-message edit / rollback / regenerate over a virtualized thread.
          Opt-in and fail-closed: with no <Code>OPENROUTER_API_KEY</Code> the
          panel shows a calm &ldquo;not configured&rdquo; state and the routes
          503.
        </Bullet>
        <Bullet>
          0.35.1 fix: scaffolded apps crashing at boot (&ldquo;Dynamic require
          of X is not supported&rdquo;) — the engine added <Code>ai</Code> +{" "}
          <Code>@openrouter/ai-sdk-provider</Code> but the{" "}
          <Code>create-hogsend</Code> template never declared them, so a
          consumer&rsquo;s tsup bundled the CJS <Code>ai</Code> tree into the
          ESM <Code>dist</Code>. The template now declares them (plus{" "}
          <Code>svix</Code>, <Code>picocolors</Code>) so tsup externalizes them,
          and <Code>verify-scaffold</Code> now boots the built app to catch this
          class of regression.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. The agent is opt-in —
        set <Code>OPENROUTER_API_KEY</Code> to enable it.
      </>
    ),
  },
  {
    version: "0.34.0",
    anchor: "0-34-0",
    date: "June 25, 2026",
    title: "Events fan out to PostHog; Discord identity, corrected",
    bullets: (
      <>
        <Bullet>
          Every ingested event can now mirror into the active analytics provider
          from the ingest spine, keyed to the resolved canonical contact key.
          Opt-in via <Code>analytics.eventMirror</Code> (or the{" "}
          <Code>ANALYTICS_EVENT_MIRROR</Code> env override), default off. It
          excludes <Code>{'source: "posthog"'}</Code> events (echo-loop guard),
          supports <Code>allow</Code> / <Code>deny</Code> event-name filters,
          and fires once on the fresh-insert side of the ingest idempotency
          guard, so retries never double-capture.
        </Bullet>
        <Bullet>
          Discord inbound transforms no longer mint{" "}
          <Code>{'userId: "discord:<id>"'}</Code> — a pre-link member is
          anonymous (keyed by the <Code>discord_id</Code> column), so a later{" "}
          <Code>/link</Code> merges it into the email / web contact in the
          correct direction (the Discord person folds onto the canonical one,
          not the reverse).
        </Bullet>
        <Bullet>
          Each inbound event now carries the actor&rsquo;s own snowflake in its
          properties (<Code>authorId</Code> / <Code>reactorId</Code> /{" "}
          <Code>memberId</Code>), so role grants and DMs fire for members who
          haven&rsquo;t linked yet, and the connector-action contact resolver
          widens to match <Code>anonymous_id</Code> and the uuid <Code>id</Code>{" "}
          column too.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. The PostHog event mirror
        is off until you set <Code>analytics.eventMirror</Code>.
      </>
    ),
  },
  {
    version: "0.33.0",
    anchor: "0-33-0",
    date: "June 24, 2026",
    title: "removeRole — Discord tenure ladders",
    bullets: (
      <>
        <Bullet>
          A <Code>removeRole</Code> outbound action mirroring{" "}
          <Code>grantRole</Code> (bot-REST <Code>DELETE</Code>, idempotent,
          soft-fails on an unresolved member or a permission / hierarchy 403),
          so a journey can demote as well as promote — a Stranger &rarr; Piglet
          &rarr; Hog member lifecycle (drop Stranger on <Code>/link</Code>, drop
          Piglet on graduating to Hog after a 7-day tenure).
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. Additive.
      </>
    ),
  },
  {
    version: "0.32.0",
    anchor: "0-32-0",
    date: "June 24, 2026",
    title: "Managed-link campaigns + connector engagement events",
    bullets: (
      <>
        <Bullet>
          <Code>link.clicked</Code> is now a first-party bus event: a click on
          any non-email managed link (Discord, SMS, referral, a standalone
          Studio link) re-ingests through the journey pipeline, so a journey can{" "}
          <Code>trigger</Code> on — or <Code>ctx.waitForEvent</Code> for — a
          click of a specific managed link (filter by <Code>linkId</Code> /{" "}
          <Code>campaign</Code>). Gated on <Code>!isBot</Code> so unfurl /
          prefetch bots are suppressed, and on a personal link&rsquo;s{" "}
          <Code>distinctId</Code> so public links carry no person.
        </Bullet>
        <Bullet>
          <Code>ctx.waitForEvent</Code> gains an optional <Code>where</Code>{" "}
          predicate (the same model as <Code>trigger.where</Code>) so a journey
          can await a specific link&rsquo;s click mid-run — an engine-side
          durable re-arm loop with a persisted <Code>wait_deadline</Code> that
          survives Hatchet replay. <Code>ctx.history.events</Code> gains an
          event-name filter.
        </Bullet>
        <Bullet>
          Connector engagement events: Discord reactions fan out into a
          reactor-keyed <Code>discord.reaction_added</Code> (carrying the target
          author for distinct-people counting) plus, when the author is known,
          an author-keyed <Code>discord.reaction_received</Code> powering
          &ldquo;your post resonated with N people&rdquo;. Adds{" "}
          <Code>discord.reaction_removed</Code> and a <Code>grantRole</Code>{" "}
          outbound action for the community-gamification loop (count an
          engagement event &rarr; grant a role + DM).
        </Bullet>
        <Bullet>
          0.32.1 fix: preserve Hatchet&rsquo;s <Code>this</Code> binding in the
          journey side-effect memoize — an unbound <Code>ctx.memo</Code> threw{" "}
          <Code>Cannot read properties of undefined</Code>, crashing every
          journey side effect (<Code>sendEmail</Code> /{" "}
          <Code>sendConnectorAction</Code> / <Code>ctx.trigger</Code>) the
          moment an eviction-capable engine made <Code>supportsEviction</Code>{" "}
          true.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. Additive.
      </>
    ),
  },
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
    version: "0.29.0",
    anchor: "0-29-0",
    date: "June 22, 2026",
    title: "createColdConnect() — one cold-connect primitive for every channel",
    bullets: (
      <>
        <Bullet>
          New <Code>createColdConnect</Code> engine primitive extracts the
          Telegram link flow (<Code>/link &lt;email&gt;</Code> &rarr; emailed
          confirm link &rarr; click &rarr; server-sealed bind &rarr; client-side{" "}
          <Code>posthog.identify</Code>) into a channel-agnostic factory, so
          Discord, Telegram, and future connectors share one mechanism. It owns
          the sealed-token store (Redis), the connect page, and the{" "}
          <Code>peek &rarr; ingestEvent &rarr; consume</Code> exchange,
          returning <Code>{"{ mintConfirm, confirmUrl, routes }"}</Code>.
        </Bullet>
        <Bullet>
          Security invariants are baked in: the bind runs only on a human POST
          (never a GET prefetch); ids come solely from the sealed token (no
          graft); single-use peek-then-consume so a webhook retry can&rsquo;t
          burn the link; a fail-closed Redis-INCR mint throttle; and
          cross-connector token isolation (a{" "}
          <Code>{"binding.connectorId === connectorId"}</Code> assert, 410 on
          mismatch). The exchange returns the canonical <Code>contactKey</Code>,
          which the page hands to <Code>posthog.identify</Code> — keyed to the
          server-proven id, never a client-supplied one.
        </Bullet>
        <Bullet>
          <Code>CreateAppOptions.routes</Code> now accepts a single fn or an
          array, so a consumer can mount{" "}
          <Code>{"[existingRoutes, coldConnect.routes]"}</Code> without
          clobbering. <Code>@hogsend/plugin-telegram</Code> is refactored onto
          the primitive; the basePath (<Code>/connect/telegram</Code>) is
          unchanged, so confirmation emails in flight keep resolving.
        </Bullet>
        <Bullet>
          The marketing site&rsquo;s PostHog init now sets{" "}
          <Code>cross_subdomain_cookie: true</Code> so a <em>consented</em>{" "}
          visitor&rsquo;s distinct_id is written to a <Code>.hogsend.com</Code>{" "}
          cookie — letting a connect page served off the API host read the
          existing id and fold prior browsing into the proven identity.
          Pre-consent behaviour (memory-only, no cookie) is unchanged.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. Additive —{" "}
        <Code>createColdConnect</Code> is a new export and the{" "}
        <Code>routes</Code> array form is backward-compatible.
      </>
    ),
  },
  {
    version: "0.28.0",
    anchor: "0-28-0",
    date: "June 22, 2026",
    title: "Telegram connector + live-only journey index",
    bullets: (
      <>
        <Bullet>
          New <Code>@hogsend/plugin-telegram</Code> — an inbound webhook
          connector for messages, the <Code>/start</Code> deep-link, and a{" "}
          <Code>/link</Code> email-confirm cold connect, with journey-callable{" "}
          <Code>sendMessage</Code>/<Code>dm</Code> actions. Linking uses
          Redis-token peek-then-consume, so a Telegram webhook retry can&rsquo;t
          burn a link mid-flight.
        </Bullet>
        <Bullet>
          Engine: <Code>uq_user_journey_active</Code> is now a PARTIAL unique
          index scoped to live rows (
          <Code>{"status IN ('active','waiting')"}</Code>), so an{" "}
          <Code>unlimited</Code> journey can complete more than once per user —
          the old full <Code>(user_id, journey_id, status)</Code> index threw{" "}
          <Code>23505</Code> on the second completion. Ships migration{" "}
          <Code>0029</Code>.
        </Bullet>
        <Bullet>
          <Code>contacts.properties.telegram</Code> now deep-merges, mirroring{" "}
          <Code>discord</Code>.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. Additive; run migration{" "}
        <Code>0029</Code> to swap the journey index to the live-only partial.
      </>
    ),
  },
  {
    version: "0.27.0",
    anchor: "0-27-0",
    date: "June 21, 2026",
    title: "Generic first-party link tracker",
    bullets: (
      <>
        <Bullet>
          The email link-tracking machinery is now a channel-agnostic primitive:{" "}
          <Code>mintLink(...)</Code> inserts a durable <Code>links</Code> row
          (operator/campaign identity) plus a <Code>tracked_links</Code>{" "}
          click-counter that back-references it via <Code>link_id</Code>, and
          returns the <Code>{"/v1/t/c/:id"}</Code> redirect URL — so Studio,
          Discord, SMS, or a share link can mint a tracked link, not just email.
          Email is unchanged: it still rewrites HTML at send time with{" "}
          <Code>link_id</Code> NULL, so the two stay independent consumers of
          one click spine.
        </Bullet>
        <Bullet>
          Share-safe by construction: a link carries a person token (a{" "}
          <Code>distinctId</Code> the click can stitch) ONLY when{" "}
          <Code>{'type: "personal"'}</Code>. A <Code>public</Code> link never
          carries one, so a reshared public link attributes by campaign only.
          Destinations are validated http(s) at mint time, closing the latent
          open-redirect.
        </Bullet>
        <Bullet>
          The <Code>hs_t</Code> identity-token redirect is now single-use: the
          first <Code>{"POST /v1/t/identify"}</Code> exchange wins, a
          replayed/reshared token is a 200 no-op (Redis <Code>SET NX</Code> on a
          sha256 of the token). Best-effort — a Redis fault degrades to the
          pre-burn behaviour rather than coupling the exchange to Redis
          liveness.
        </Bullet>
        <Bullet>
          A new Studio &ldquo;Links&rdquo; view mints personal/public links,
          copies the short URL, shows per-link click counts, and archives —
          backed by admin CRUD at <Code>/v1/admin/links</Code>.{" "}
          <Code>@hogsend/db</Code> adds the <Code>links</Code> table +{" "}
          <Code>tracked_links.link_id</Code> FK (additive migration{" "}
          <Code>0028</Code>).
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. Additive; run the{" "}
        <Code>0028</Code> migration.
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
