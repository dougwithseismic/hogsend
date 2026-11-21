# Market (scanned 2026-11-21)

Public pages only; prices as listed on the date above. Re-check before quoting
any competitor fact in copy.

## The buyer and the job

A technical founder or product engineer at a product-led software company. The
job: when a customer does something important, or fails to, make the product
respond (onboarding, trial conversion, dunning, win-back) without running a
second operating system in a marketing canvas. Today they use a canvas tool
(Customer.io, Loops, PostHog Workflows, Knock), or they hand-roll drips on a
durable-execution engine (Inngest/Trigger.dev + Resend + React Email), often
with a coding agent writing the code.

## Alternatives

| Name | Who it's for | Price (2026-11-21) | Strong at | Complaints (sourced) |
|------|--------------|--------------------|-----------|----------------------|
| PostHog Workflows | PostHog users | 10k emails/mo free, then $0.003→$0.00025/email | Same identity as analytics/flags; Broadcasts (Oct 2026), push (Sep 2026), 19 MCP tools | Shared SES IPs only, no BYO provider, new projects start at 100 emails/day ([docs](https://posthog.com/docs/workflows/sending-reputation)); "wait until" steps silently failed for 23 days ([post-mortem](https://posthog.com/handbook/company/post-mortems/2026-04-27-workflow-wait-until-condition)) |
| Customer.io | Growth/marketing teams | Essentials $100/mo for 5k profiles; Builder plan PAYG (no behavioural workflows) | Deepest behavioural journeys; AI agent, Goals, LLM Actions; CLI with agent self-signup | Cost as lists grow, cluttered multi-branch journeys, single-condition exits ([G2](https://www.g2.com/products/customer-io/reviews_and_filters)) |
| Loops | SaaS startups | Free to 1k contacts; $49/mo | Simplicity; free transactional; Workflows API + Claude connector (2026-11-20) | No company/account model; imported suppressions don't block transactional ([migration guide](https://loops.so/resources/migrate-mailchimp-to-loops)) |
| Resend Automations | Developers already on Resend | 10k runs free, then $0.0015/run | Developer email API, React Email 6 with embeddable editor, CLI 2.0 with agent skills | Canvas/JSON steps; logic lives in Resend, not your repo |
| Knock | Product notifications | Free 10k msgs; Starter $250/mo + $0.005/msg | CLI pull/push, branches, sandbox mode, skip-delays test runner (2026-06-30) | $0→$250 jump; i18n, per-tenant prefs, audit logs Enterprise-only ([pricing](https://knock.app/pricing)) |
| Novu | Notification infra | Free 10k runs / 5 workflows; Pro from $30 | TypeScript framework, Inbox component, MIT core | Bridge endpoint must be public with a 5 s timeout ([docs](https://docs.novu.co/framework/endpoint)) |
| Inngest / Trigger.dev + Resend (DIY) | Engineers building it themselves | Inngest free 50k execs, Pro $99; Trigger.dev $10/$50 | Durable steps, waitForEvent, self-host | No unsubscribe, preferences, suppression, tracking or idempotent sends out of the box; every sleep is a billed step |
| Dittofeed / Laudspeaker / Parcelvoy | Self-hosters | Free | — | Dittofeed Cloud closed 2026-10-31; Laudspeaker unmaintained; Parcelvoy archived 2026-02-18 |

New entrants to watch: subscriber.dev (AGPL, MCP/CLI-first, JSON workflows,
$19/mo hosted), Reloop (Apache-2.0, email-only), Sequenzy (AI-written
sequences), Hightouch Lifecycle Studio (enterprise, 2026-06-24).

## Table stakes

Each is shipped or a backlog row.

| Expectation | Hogsend |
|---|---|
| Durable waits, idempotent sends | Have (exactly-once across replays) |
| Test mode / test sends | Have |
| Run journeys on a simulated clock (Knock skip-delays) | Partial: `@hogsend/testing` harness, no `simulate` CLI |
| Per-user timeline, run history | Have |
| Broadcasts + segments | Partial: campaigns + buckets, no visual segment builder |
| Suppression, bounces, complaints, preference center | Have |
| RFC 8058 one-click unsubscribe (Gmail bulk-sender rule) | Have: `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` on every tracked send |
| Deliverability dashboard (bounce/complaint rate alerts) | Missing |
| Frequency caps, send windows, A/B, holdouts | Have |
| Typed SDKs | Have for TypeScript |
| MCP + llms.txt + CLI skills | Have (stdio MCP); remote MCP with OAuth unclear |
| Copy edits without a deploy | Missing |
| Import from incumbents | Have: `hogsend import loops|customerio|csv` incl. suppressions |
| Quickstart that type-checks | Broken on 0.67.0 (scaffold `check-types` OOM); fixed on `main` by PRD 06, publishes with the next release |
| Native mobile push | Missing |
| i18n | Missing |
| Hosted option | Missing (homepage says self-host only, ELv2) |

## Our wedge

1. **Executable, typed journeys in the customer's repo, reviewed in a PR and
   checked by CI.** Every incumbent stops at "an agent drafts it in our UI,
   then you publish there" (Loops, Customer.io Builder, Knock agent mode,
   PostHog MCP). Hogsend is the code itself.
2. **The batteries the DIY stack is missing.** Teams and their agents already
   build drips on Inngest/Trigger.dev + Resend; Hogsend gives them exactly-once
   sends, unsubscribe/preferences/suppression, first-party tracking and
   identity out of the box, on infrastructure they own.

Supporting: durability as a feature (the PostHog post-mortem), BYO email
provider, and no per-contact pricing.

## Switching kit

| From | What it takes | Have |
|---|---|---|
| Customer.io | Contacts with ID mapping, unsubscribes + suppressions (+ delta sync after export), Liquid → React Email, journey rebuild with mid-journey enrollment, event backfill, parallel run | Import of contacts + suppressions; rest missing |
| Loops | Same, minus Liquid; Loops Workflows API now exports flows | Import of contacts + suppressions |
| PostHog Workflows | Workflow export → `defineJourney`; identity already shared | PostHog integration; translator missing |
| DIY Inngest/Resend | Wrap existing functions as journeys; keep Resend as the provider | Resend provider is the default |

## Openings

- Quickstart type-check is broken → **PRD 06** (merged, awaiting publish).
- "Will you exist next year?" after three self-host peers died → trust/longevity
  story on the landing page and a supported one-click deploy (later PRD).
- Hatchet's "hundreds of tasks/s" default is the obvious scale objection →
  publish a benchmark after the hot-path work (later PRD).
- Gmail bulk-sender rules → RFC 8058 verified; add a deliverability panel (PRD 17).
- Agent-opens-the-PR flow with a simulated timeline in the PR comment
  (`hogsend simulate`) — nobody else can do this structurally.

## Watching

- Loops: Workflows API, Claude connector, revision-safe writes (2026-11-20).
- PostHog Workflows: transactional SDKs in 8 languages (2026-11), Broadcasts
  (2026-10), push (2026-09).
- Resend: Automations (2026-04-13), React Email 6 embeddable editor.
- Knock: sandbox mode + skip-delays test runner (2026-06-30).
- Customer.io: CLI with agent self-signup, LLM Actions.
- Courier: CLI (2026-03-12), Experiments (2026-07), synthetic users essay (2026-11-02).
