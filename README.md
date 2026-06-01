<p align="center">
  <img src="hogsend-banner.png" alt="Hogsend" width="100%" />
</p>

# Hogsend

[![CI](https://github.com/dougwithseismic/hogsend/actions/workflows/ci.yml/badge.svg)](https://github.com/dougwithseismic/hogsend/actions/workflows/ci.yml)

The lifecycle email automation that PostHog teams actually need. Code-first, self-hosted, open source.

PostHog tells you what users do. Resend delivers your emails. Hogsend is the bit in the middle — it listens for events, decides who gets what, waits, checks conditions, and sends. Journeys are TypeScript functions, not YAML configs or drag-and-drop canvases.

Built for small teams (1-10 eng) shipping product-led SaaS who picked PostHog and Resend and now need behavioral sequences without buying a third platform.

**[Documentation](https://docs.hogsend.com)** | **[Getting Started](https://docs.hogsend.com/docs/getting-started)** | **[CLI Reference](https://docs.hogsend.com/docs/cli)** | **[Compare](https://docs.hogsend.com/docs/compare)**

Everything ships on npm: scaffold an app with `pnpm dlx create-hogsend@latest`, self-host with Docker, or one-click on Railway.

---

## How It Works

Events flow in from PostHog, journeys react with emails via Resend, engagement data flows back. A closed loop — product analytics and lifecycle email in the same event stream.

<p align="center">
  <img src="hogsend-lifecycle.png" alt="PostHog Lifecycle Email Flow" width="100%" />
</p>

> Deep dive: **[How It Works](https://docs.hogsend.com/docs/concepts/how-it-works)** | **[Why PostHog?](https://docs.hogsend.com/docs/concepts/why-posthog)** | **[Why Hatchet?](https://docs.hogsend.com/docs/concepts/why-hatchet)** | **[Philosophy](https://docs.hogsend.com/docs/concepts/philosophy)**

---

## What You Can Build

- **Welcome sequences** that branch based on whether the user actually used the product
- **Trial-to-paid conversion** that watches for usage milestones and sends different emails depending on engagement
- **Payment failure recovery** — escalating reminders that stop the moment the payment goes through
- **Dormancy reactivation** — detect inactive users, run a win-back series, track if they come back
- **NPS / feedback collection** timed after key moments
- **Abandoned checkout recovery** — start a sequence when checkout begins, exit when it completes
- **Cross-journey orchestration** — one journey enrolls a user in another, chaining sequences without duplicating logic

Each is a single TypeScript file using `defineJourney()`. The repo ships with [10 production-ready journeys](apps/api/src/journeys/) covering common lifecycle stages.

---

## Example Emails

Hogsend dogfoods itself. The example templates in [`apps/api/src/emails/`](apps/api/src/emails/) are real lifecycle emails _about_ Hogsend — built with [React Email](https://react.email) + Tailwind, sent through journeys defined in code. They're yours to edit, rebrand, or delete. Here's the set as it ships:

<table>
  <tr>
    <td width="33%" valign="top"><b>Setup guide</b><br/><sub><code>activation-quickstart</code></sub><br/><img src="apps/docs/public/images/emails/activation-quickstart.png" alt="Setup guide email — get your first journey live" width="100%"/></td>
    <td width="33%" valign="top"><b>No events yet</b><br/><sub><code>activation-nudge</code></sub><br/><img src="apps/docs/public/images/emails/activation-nudge.png" alt="Activation nudge email — we haven't seen any events yet" width="100%"/></td>
    <td width="33%" valign="top"><b>Journeys as code</b><br/><sub><code>activation-feature-highlight</code></sub><br/><img src="apps/docs/public/images/emails/activation-feature-highlight.png" alt="Feature highlight email — journeys are just TypeScript" width="100%"/></td>
  </tr>
  <tr>
    <td width="33%" valign="top"><b>What others build</b><br/><sub><code>activation-community</code></sub><br/><img src="apps/docs/public/images/emails/activation-community.png" alt="Community email — see what other teams ship" width="100%"/></td>
    <td width="33%" valign="top"><b>Usage milestone</b><br/><sub><code>conversion-usage-milestone</code></sub><br/><img src="apps/docs/public/images/emails/conversion-usage-milestone.png" alt="Usage milestone email — 100 emails sent" width="100%"/></td>
    <td width="33%" valign="top"><b>Trial ending</b><br/><sub><code>conversion-trial-expiring</code></sub><br/><img src="apps/docs/public/images/emails/conversion-trial-expiring.png" alt="Trial expiring email — your trial ends in 3 days" width="100%"/></td>
  </tr>
  <tr>
    <td width="33%" valign="top"><b>Win-back offer</b><br/><sub><code>conversion-winback-offer</code></sub><br/><img src="apps/docs/public/images/emails/conversion-winback-offer.png" alt="Win-back offer email — 20% off" width="100%"/></td>
    <td width="33%" valign="top"><b>Milestone unlocked</b><br/><sub><code>retention-achievement</code></sub><br/><img src="apps/docs/public/images/emails/retention-achievement.png" alt="Achievement email — 10,000 emails delivered" width="100%"/></td>
    <td width="33%" valign="top"><b>Weekly digest</b><br/><sub><code>retention-weekly-digest</code></sub><br/><img src="apps/docs/public/images/emails/retention-weekly-digest.png" alt="Weekly digest email — your Hogsend week" width="100%"/></td>
  </tr>
  <tr>
    <td width="33%" valign="top"><b>Dormancy check-in</b><br/><sub><code>reactivation-checkin</code></sub><br/><img src="apps/docs/public/images/emails/reactivation-checkin.png" alt="Reactivation check-in email — your project's gone quiet" width="100%"/></td>
    <td width="33%" valign="top"><b>Final nudge</b><br/><sub><code>reactivation-final-nudge</code></sub><br/><img src="apps/docs/public/images/emails/reactivation-final-nudge.png" alt="Final nudge email — we'll leave it here" width="100%"/></td>
    <td width="33%" valign="top"><b>NPS survey</b><br/><sub><code>feedback-nps-survey</code></sub><br/><img src="apps/docs/public/images/emails/feedback-nps-survey.png" alt="NPS survey email — how are we doing" width="100%"/></td>
  </tr>
  <tr>
    <td width="33%" valign="top"><b>Payment failed</b><br/><sub><code>churn-payment-failed</code></sub><br/><img src="apps/docs/public/images/emails/churn-payment-failed.png" alt="Payment failed email — we couldn't process your payment" width="100%"/></td>
    <td width="33%"></td>
    <td width="33%"></td>
  </tr>
</table>

---

## Quick Example

A `user_signed_up` event triggers this journey. It sends a welcome email, waits two days, checks if the user tried the core feature, and nudges them if not:

```typescript
import { days, defineJourney, sendEmail } from "@hogsend/engine";
import { Events, Templates } from "./constants/index.js";

export const activationWelcome = defineJourney({
  meta: {
    id: "activation-welcome",
    name: "Activation — Welcome Series",
    enabled: true,
    trigger: { event: Events.USER_CREATED },
    entryLimit: "once",
    exitOn: [{ event: Events.USER_DELETED }],
  },

  run: async (user, ctx) => {
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyName: user.journeyName,
      template: Templates.ACTIVATION_WELCOME,
      subject: "Welcome — let's get you set up",
    });

    await ctx.sleep({ duration: days(2), label: "post-welcome" });

    const { found } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.FEATURE_USED,
    });

    if (!found) {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyName: user.journeyName,
        template: Templates.ACTIVATION_NUDGE,
        subject: "You haven't tried the key feature yet",
      });
    }
  },
});
```

That `ctx.sleep(days(2))` literally pauses for two days and picks up exactly where it left off — durable execution via [Hatchet](https://hatchet.run) that survives deploys and restarts.

> Full guide: **[Journeys](https://docs.hogsend.com/docs/guides/journeys)** | **[Events](https://docs.hogsend.com/docs/guides/events)** | **[Email](https://docs.hogsend.com/docs/guides/email)** | **[Conditions](https://docs.hogsend.com/docs/guides/conditions)**

---

## Get Started

Scaffold a fresh app with `create-hogsend`. It generates a thin app that pins `@hogsend/engine` and holds your content — journeys, email templates, webhook sources — then installs everything from npm:

```bash
pnpm dlx create-hogsend@latest my-app
cd my-app

cp .env.example .env        # set BETTER_AUTH_SECRET, RESEND_API_KEY, HATCHET_CLIENT_TOKEN
docker compose up -d        # Postgres, Redis, Hatchet-Lite
pnpm db:migrate             # engine track, then your client track
pnpm dev                    # API on http://localhost:3002
pnpm worker:dev             # Hatchet worker, in a second terminal
```

Fire a `user_signed_up` event and watch the journey run. Upgrade the framework with `pnpm up "@hogsend/*"` — never a fork or a merge.

> Full guide: **[Installation](https://docs.hogsend.com/docs/getting-started/installation)** | **[Configuration](https://docs.hogsend.com/docs/getting-started/configuration)** | **[PostHog Setup](https://docs.hogsend.com/docs/getting-started/posthog-setup)**

### The Hatchet token

Journeys are durable, which is what lets `ctx.sleep(days(2))` pause for two days and survive deploys. That durability is backed by [Hatchet](https://hatchet.run), so you need a `HATCHET_CLIENT_TOKEN`. The local `docker compose` runs `hatchet-lite` for you — mint a token from its dashboard at [`localhost:8888`](http://localhost:8888), or use [Hatchet Cloud](https://cloud.onhatchet.run) if you'd rather not run it yourself.

> Full guide: **[Hatchet setup](https://docs.hogsend.com/docs/getting-started/hatchet)**

### Deploy

Same app, deployed your way. One-click on Railway, or self-host the full stack anywhere that runs Node.js + Postgres:

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/LxSCyR)

> Full guide: **[Deploy on Railway](https://docs.hogsend.com/docs/operating/deploy-railway)** | **[Deploy with Docker](https://docs.hogsend.com/docs/operating/deploy-docker)**

---

## CLI

`@hogsend/cli` is the agent-native companion — install it with `pnpm add -g @hogsend/cli`, or run any command through `pnpm dlx @hogsend/cli`. It talks to a running instance's admin API; pass `--json` for machine-readable output.

```bash
hogsend doctor      # Probe a running instance's health
hogsend journeys    # List, inspect, enable, and disable journeys
hogsend contacts    # List, inspect, and trace contact activity
hogsend stats       # System-wide overview metrics
hogsend events      # Stream a single user's event history
hogsend setup       # Local onboarding — docker compose up, gen secret, db:migrate
hogsend skills      # Install bundled Claude Code skills into .claude/skills
hogsend eject       # Vendor a @hogsend/* package into vendor/<name>
hogsend patch       # Patch a package via pnpm's native patch flow
```

> Full reference: **[CLI Reference](https://docs.hogsend.com/docs/cli)**

---

## Stack

| Concern | Tool |
|---------|------|
| HTTP API | Hono on Node.js |
| Durable execution | Hatchet (sleeps, retries, event routing) |
| Database | TimescaleDB (Postgres 18) via Drizzle ORM |
| Cache | Redis |
| Email delivery | Resend (`@hogsend/plugin-resend`) |
| Product analytics | PostHog (`@hogsend/plugin-posthog`) |
| Email templates | React Email |
| CLI | TypeScript on Node (`@hogsend/cli`) |
| Deploy | Railway (one-click), Docker Compose, or bring-your-own |

Plugins are standalone packages — create your own for Slack, Twilio, or any service. See **[Creating Plugins](https://docs.hogsend.com/docs/guides/plugins)**.

---

## Explore the Docs

| Section | What's there |
|---------|-------------|
| **[Getting Started](https://docs.hogsend.com/docs/getting-started)** | Installation, PostHog setup, configuration reference |
| **[Concepts](https://docs.hogsend.com/docs/concepts/how-it-works)** | How it works, why PostHog, why Hatchet, philosophy |
| **[Compare](https://docs.hogsend.com/docs/compare)** | Hogsend vs Customer.io, Loops, Brevo, ActiveCampaign — feature matrix and migration |
| **[Building](https://docs.hogsend.com/docs/guides/journeys)** | Journeys, events, email, conditions, creating plugins |
| **[CLI Reference](https://docs.hogsend.com/docs/cli)** | Every command documented with examples |
| **[Operating](https://docs.hogsend.com/docs/operating)** | Deployment, auth, monitoring, metrics, bulk ops, troubleshooting |
| **[API Reference](https://docs.hogsend.com/docs/api)** | Every endpoint with request/response examples |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code style, and how to submit changes.

## License

[Elastic License 2.0 (ELv2)](LICENSE) — use, modify, and self-host freely. You can't offer it as a managed service or remove license key functionality. See [LICENSE](LICENSE) for full terms.
