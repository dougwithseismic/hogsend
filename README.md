<p align="center">
  <img src="hogsend-banner.png" alt="Hogsend" width="100%" />
</p>

# Hogsend

[![CI](https://github.com/dougwithseismic/hogsend/actions/workflows/ci.yml/badge.svg)](https://github.com/dougwithseismic/hogsend/actions/workflows/ci.yml)

The lifecycle email automation that PostHog teams actually need. Code-first, self-hosted, open source.

PostHog tells you what users do. Resend delivers your emails. Hogsend is the bit in the middle — it listens for events, decides who gets what, waits, checks conditions, and sends. Journeys are TypeScript functions, not YAML configs or drag-and-drop canvases.

Built for small teams (1-10 eng) shipping product-led SaaS who picked PostHog and Resend and now need behavioral sequences without buying a third platform.

> ⚠️ **Breaking changes are incoming** — by all means get excited and read the docs, but hold off for a day or two before building on the current setup. It'll be worth it!

**[Documentation](https://docs.hogsend.com)** | **[Getting Started](https://docs.hogsend.com/docs/getting-started)** | **[CLI Reference](https://docs.hogsend.com/docs/cli)** | **[Compare](https://docs.hogsend.com/docs/compare)**

Self-host with Docker (the default), or one-click on Railway. Same image, same env contract — [pick a target](https://docs.hogsend.com/docs/operating/deployment).

---

## How It Works

Events flow in from PostHog, journeys react with emails via Resend, engagement data flows back. A closed loop — product analytics and lifecycle email in the same event stream.

<p align="center">
  <img src="hogsend-lifecycle.png" alt="PostHog Lifecycle Email Flow" width="100%" />
</p>

> Deep dive: **[How It Works](apps/docs/content/docs/concepts/how-it-works.mdx)** | **[Why PostHog?](apps/docs/content/docs/concepts/why-posthog.mdx)** | **[Why Hatchet?](apps/docs/content/docs/concepts/why-hatchet.mdx)** | **[Philosophy](apps/docs/content/docs/concepts/philosophy.mdx)**

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

## Quick Example

A `user_signed_up` event triggers this journey. It sends a welcome email, waits two days, checks if the user tried the core feature, and nudges them if not:

```typescript
import { days } from "@hogsend/core";
import { sendEmail } from "../lib/email.js";
import { Events, Templates } from "./constants/index.js";
import { defineJourney } from "./define-journey.js";

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

> Full guide: **[Journeys](apps/docs/content/docs/guides/journeys.mdx)** | **[Events](apps/docs/content/docs/guides/events.mdx)** | **[Email](apps/docs/content/docs/guides/email.mdx)** | **[Conditions](apps/docs/content/docs/guides/conditions.mdx)**

---

## Get Started

### Step 1 — acquire a Hatchet

Hogsend's one prerequisite is a [Hatchet](https://hatchet.run) token — it's what makes `ctx.sleep(days(2))` survive deploys. There is **no auto-mint**: you bring the token. Get one from [Hatchet Cloud](https://cloud.onhatchet.run) (paste a token), the self-hosted `hatchet-lite` dashboard (mint it at `:8888`), or your own engine, then set the three `HATCHET_CLIENT_*` vars.

> Full guide: **[Acquire a Hatchet](apps/docs/content/docs/getting-started/hatchet.mdx)**

### Self-host with Docker (the default)

The full stack — Postgres, Redis, hatchet-lite, plus the migrate/api/worker run modes off one image — comes up from `docker-compose.prod.yml`. Bring up the engine first, mint a token, then start the app:

```bash
cp .env.example .env                                          # set BETTER_AUTH_SECRET, RESEND_API_KEY
docker compose -f docker-compose.prod.yml up -d hatchet-lite  # 1. engine first
# 2. mint a token at http://localhost:8888 → paste into .env as HATCHET_CLIENT_TOKEN
docker compose -f docker-compose.prod.yml up -d --build       # 3. full stack
```

> Full guide: **[Deploy with Docker](apps/docs/content/docs/operating/deploy-docker.mdx)**

### One-click on Railway (one paved option)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/LxSCyR)

Railway is a managed on-ramp — same image, same env contract, just less to run yourself. The `hogsend` CLI discovers your Railway project, generates secrets, creates a PostHog webhook destination, and fires a test event:

```bash
curl -L https://github.com/dougwithseismic/hogsend/releases/latest/download/hogsend_darwin_arm64.tar.gz | tar xz
sudo mv hogsend /usr/local/bin/
hogsend init && hogsend test
```

> Full guide: **[Deploy on Railway](apps/docs/content/docs/operating/deploy-railway.mdx)**

### Local Development

```bash
git clone https://github.com/dougwithseismic/hogsend.git && cd hogsend
pnpm setup        # Docker, deps, .env (generates BETTER_AUTH_SECRET)
pnpm dev          # API on :3002
# separate terminal:
cd apps/api && hatchet worker dev
```

> Full guide: **[Installation](apps/docs/content/docs/getting-started/installation.mdx)** | **[Configuration](apps/docs/content/docs/getting-started/configuration.mdx)** | **[PostHog Setup](apps/docs/content/docs/getting-started/posthog-setup.mdx)**

---

## CLI

```bash
hogsend init        # Connect Railway project, configure PostHog webhook, verify pipeline
hogsend setup       # Local dev — Docker, deps, .env
hogsend status      # Health check
hogsend deploy      # Trigger Railway redeploy
hogsend test        # Fire test event, verify it arrives
hogsend journeys    # Enable/disable journeys
hogsend contacts    # Manage contacts (list, create, update, delete, prefs)
hogsend destroy     # Tear down Railway project
```

> Full reference: **[CLI Reference](apps/docs/content/docs/cli/index.mdx)**

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
| CLI | Go (cobra + charmbracelet) |
| Deploy | Docker Compose (default), Railway, or bring-your-own |

Plugins are standalone packages — create your own for Slack, Twilio, or any service. See **[Creating Plugins](apps/docs/content/docs/guides/plugins.mdx)**.

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
