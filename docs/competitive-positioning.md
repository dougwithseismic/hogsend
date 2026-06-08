# Competitive Positioning & Strategy

**Status:** living strategy doc. Captures who Hogsend is for, who it is
deliberately *not* for, how it differs from the obvious comparable
(Laudspeaker → PostHog Workflows), and the product principles that follow.

---

## Thesis (one paragraph)

Marketers will never go code-first — they want a canvas, and PostHog already
bought the best open-source one (Laudspeaker) and shipped it as PostHog
Workflows. Chasing that audience is a losing race. But there is a real, growing
audience the canvas can't serve: **developers, indie startups, and consultants
who spin up lifecycle automation with code** (often with Claude Code or their own
hands) and want it in git, tested, self-hosted, and on their own ESP. Hogsend is
the tool for *them* — and, explicitly, **for us**: the thing a consultant drops
into a client and has running the same afternoon.

---

## The market reality

Laudspeaker — the open-source no-code journey builder, "alternative to Braze /
Customer.io / Appcues" — was **acquired by PostHog in May 2025** and became
**PostHog Workflows / Messaging** (now GA: native email, targeting on PostHog
data, ~2-day migrations from other tools).

The strategic consequence: **the "get acquired by PostHog as their messaging
layer" path is closed.** PostHog now *owns* that product. We do not compete with
PostHog Workflows on its terms (no-code, in-cloud, for marketers). We win on the
opposite axis.

| | Laudspeaker / PostHog Workflows | Hogsend |
|---|---|---|
| Authoring | Visual no-code canvas | **Code-first TypeScript** (`defineJourney`) |
| Audience | Marketers, PMs | **Developers, indie startups, consultants** |
| Channels OOTB | Email, SMS, push, webhook | Email (Resend); others = write a function |
| Execution | RabbitMQ queues | **Hatchet** durable TS control flow |
| Distribution | Fork / cloud | **Versioned engine as an npm dependency** |
| Data | Self-host or PostHog cloud | **Fully self-hosted, your DB, your ESP** |
| Interface | Full GUI | **Agent-native CLI + Claude Code skills** (web UI deferred) |
| License | AGPL-3.0 | ELv2 (more permissive for commercial self-host) |

---

## Who Hogsend is for (ICP)

1. **Code-first builders.** Devs and technical founders at PLG SaaS (1–10 eng) on
   PostHog + Resend who want lifecycle sequences as *code* — version-controlled,
   code-reviewed, type-safe, tested in CI — not config that drifts in a SaaS UI.
2. **Consultants & agencies (the "build for me" audience).** This is the wedge we
   keep underrating. A consultant lands a client and can say *"I'll have your
   entire lifecycle email set up this afternoon"* — clone, write journeys (with
   Claude Code), deploy to the client's own infra, hand it over. The product is a
   **force multiplier for the person setting it up**, billable and repeatable
   across clients. Hogsend should optimise relentlessly for time-to-first-journey
   for *this* person.
3. **Data-sovereign teams.** Anyone who must keep customer data in their own
   infrastructure and off a third-party messaging cloud.

> Litmus test for any feature: *does it make a consultant faster at standing this
> up for a client, or a dev happier owning journeys in code?* If yes, build it. If
> it only helps a marketer click around, it's out of scope.

## Who Hogsend is explicitly NOT for

- **Marketers who want a drag-and-drop canvas.** PostHog Workflows / Customer.io /
  Braze own this. We will not chase it, and we will not apologise for not having a
  visual journey *authoring* builder. That absence is a positioning choice, not a
  gap.

---

## The moat (why code-first wins for this audience)

- **Journeys are code** — diffable, reviewable, testable, no config drift, no
  "who changed this in the dashboard last Tuesday."
- **Durable execution via Hatchet** — `ctx.sleep(days(2))` survives deploys; real
  control flow, not a flowchart approximating it.
- **New channel = a function.** Slack/SMS/push is just a journey calling your own
  module — no plugin marketplace, no waiting on a vendor.
- **Event fan-out = a registered transform, not a vendor lock.** Outbound
  destinations (`defineDestination()`) ride one durable spine, so PostHog is a
  *peer destination* (Segment, Slack, a CRM, a warehouse get the same event
  stream), not a privileged center the engine is wired around. The PostHog
  dependency is now just the identity *pull* (person properties → timezone).
- **Engine as a versioned dependency** (the boundary-revision work) — you get
  upgrades *and* own your content. Templates, providers, and journeys live in your
  repo; the framework is a pinned package you bump.
- **Multi-provider, self-hosted.** Your ESP (Resend by default, swappable
  provider), your database, your deploy.

---

## The interface is the CLI + skills, not a UI

For a code-first, *agentic-ready* product (it's literally in the tagline), the
natural interface isn't a web dashboard — it's **a CLI the developer's agent
(Claude Code) drives, plus skills that teach the agent the domain.** The
consultant doesn't click around; their agent runs commands and reads structured
output. That's what replaces "the dashboard" for our audience: **the agent + CLI
*is* the studio.**

Two design principles:

- **Every command speaks JSON.** A `--json` mode (machine output) so an agent can
  pull stats, inspect a journey, read a contact timeline, and reason over the
  result; pretty output for humans. This is what makes "ask Claude how journey X
  is doing" work — it shells out and parses.
- **Skills are installable.** `hogsend skills add` drops Claude Code skills into
  `.claude/skills/` that teach the agent how to write a journey, add a webhook
  source / channel, query stats, debug a stuck journey, and run migrations safely.
  Open Claude Code in a Hogsend repo and it immediately knows the domain. This is
  the agentic loop: the agent calls skills, the skills call the CLI, the CLI
  talks to the engine.

### Solve the two-CLI problem: consolidate on one Node CLI

Today there are **two binaries both named `hogsend`**, which is the root of the
confusion:

- **Go CLI** (`cli/`, v0.2.0) — `init / setup / deploy / destroy / status / test /
  journeys / contacts`. Global provisioning + ops, shipped as static binaries.
- **Node CLI** (`@hogsend/cli`, 0.0.1) — `eject` (+ `patch`). In-repo editability
  ladder, installed with the engine.

**Decision:** a single CLI named `hogsend`, shipped from the **`@hogsend/cli`**
(Node) package, which absorbs `eject` + `patch` (it already has them) **and** the
provisioning/data/skills commands. Rationale: the agent-facing commands (stats,
journeys, contacts, db queries) need the engine's DB layer and types — a Node CLI
imports them directly and stays in lockstep with the schema, whereas a Go CLI has
to reimplement every query. The audience already has Node; the "static binary, no
runtime" perk is marginal when scaffolding is already `pnpm dlx create-hogsend`.
One language, one binary, one help surface for the agent. **The Go CLI (`cli/`)
gets revisited / retired** once its commands are reimplemented in the Node CLI.

**Preserving the charm.** The reason to keep the Go CLI is its
[charm.land](https://charm.sh) (Bubble Tea / Lip Gloss / Huh) delight — that
matters, the interactive `init`/`deploy` flows should feel great. Charm is
Go-only, so the single-Node-CLI path recaptures that with the closest JS
equivalents: **`@clack/prompts`** (charm-inspired, genuinely beautiful prompts)
for the interactive flows, and optionally **`ink`** (React-for-the-terminal) for
richer views like a live journey-run table. Honest caveat: this gets ~90% of the
charm feel, not 100% — Bubble Tea is best-in-class. If the charm is truly
non-negotiable, the only alternative is a thin Go front-end that proxies data
commands to the Node core — but that reintroduces the two-binary cost we're
deleting, so the default is: **one Node `hogsend`, charm-equivalent TUI via clack
/ ink.**

Target command surface (one `hogsend`, JSON-everywhere):

- **provisioning / ops:** `init`, `deploy`, `destroy`, `status`, `test`
- **codebase:** `eject`, `patch`
- **agent data / ops:** `stats`, `journeys` (list / inspect / enable / disable),
  `contacts` (list / get / timeline), `events`, `query` (read-only DB)
- **skills:** `skills add`, `skills list`

> Migration cost: the README + `docs/cli/*` currently document the Go install
> (`curl` tarball); those move to the Node CLI. That's the user's call to greenlight.

## Hogsend Studio (later / maybe)

A read-only web dashboard (runs, contact timelines, metrics, template previews) is
still a reasonable idea for **non-agent stakeholders** — e.g. showing a client
their lifecycle running. But it's **deferred**: the CLI + skills serves the primary
audience first, and a UI is a lot of surface for a "nice to have." If it's ever
built, the same rule holds — **observe & operate, never author.**

---

## The Resend angle (reframed exit/partnership)

PostHog is no longer the natural home — but **Resend is wide open.** Resend has a
best-in-class *send* API and **no lifecycle / journey / automation layer**.
Hogsend is literally "PostHog + Resend." The opportunity: **be to Resend what
Laudspeaker was to PostHog** — the automation product layered on their primitive.

Implications:
- Treat Resend as the first-class default provider and stay deeply aligned with
  it; be the reference lifecycle layer in the Resend ecosystem.
- Build the relationship/visibility deliberately (community, integrations,
  presence) rather than banking on a single acquisition event.

---

## Strategic non-goals

- No visual journey authoring. Ever, as a core thesis.
- Not chasing marketer self-serve.
- Not banking on a PostHog acquisition.
- Not a hosted multi-tenant SaaS first — self-host / consultant-deploy is the
  primary distribution.

---

## Open questions / next

- **CLI consolidation:** greenlight retiring the Go CLI and folding everything into
  one Node `hogsend`? (Sequencing, and what to do with the existing v0.2.0
  binaries / README install instructions.)
- **Skills v0:** which Claude Code skills ship first via `hogsend skills add`
  (write-a-journey, add-a-channel, debug-a-journey, query-stats, migrate-safely),
  and where do the skill files live in the repo so the CLI can copy them?
- **JSON-everywhere:** add a `--json` contract to the agent-facing commands so
  output is machine-parseable by default for agents.
- **Consultant quickstart:** how fast can a clean clone go from zero to a deployed,
  sending journey? Measure and shrink it.
- Hogsend Studio: parked until the above land.
