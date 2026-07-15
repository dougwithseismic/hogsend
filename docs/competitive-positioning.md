# Hogsend Positioning

**Status:** Approved positioning direction, 15 July 2026. This is the source of
truth for the landing page and GitHub README narrative. It describes the
position Hogsend is growing into, not merely the PostHog-led wedge it started
with.

## The decision

Hogsend is a **code-first lifecycle automation framework for product-led
teams**.

The positioning stack is:

- **Belief:** Your customer lifecycle belongs in your repo.
- **Category:** Lifecycle automation, in code.
- **Audience:** Technical founders and product engineers building product-led
  software.
- **Differentiator:** Written by you or your coding agent, reviewed in a PR,
  tested, versioned, and shipped like the rest of your product.
- **Outcome:** Ship onboarding, conversion, retention, payment recovery, and
  win-back systems faster.

The mission-sized expression is:

> **Help product engineers ship the customer lifecycle as fast as they ship
> the product.**

PostHog is an excellent integration and a natural companion. It is not a
prerequisite, the product category, or the centre of the story.

## Who we are speaking to

The primary audience is the **technical founder or founding engineer building
a product-led software company**.

They are already instrumenting the product, writing application code, and
shipping quickly. They know that onboarding, trial conversion, retention,
dunning, win-back, referrals, and customer communication matter, but they do
not want to create a second operating system inside a marketing automation
canvas.

They may use PostHog, but PostHog usage is not what makes them the right
customer. Their defining belief is that important product behaviour belongs
in code.

Secondary audiences:

- Growth engineers and product engineers who own activation, conversion, and
  retention.
- Consultants and agencies who repeatedly install lifecycle systems for
  clients and need a fast, transferable foundation.
- Small technical teams that value self-hosting, provider choice, and owning
  their customer data.

Hogsend is deliberately not for a marketing team that wants a drag-and-drop
journey canvas. Customer.io, Braze, Loops, Brevo, Klaviyo, and PostHog
Workflows already serve that preference.

## The job to be done

The functional job is:

> When a customer does something important—or fails to—help me make the
> product respond automatically, so more people activate, convert, and stay.

The operational job is:

> Let my team build, test, review, deploy, and improve the customer lifecycle
> with the same workflow we use for the product itself.

The emotional job is:

> Give me confidence that potential customers and revenue are not quietly
> leaking away because nobody built the right response.

Hogsend is not primarily selling email delivery. It is selling the response
system between a customer signal and the next best action.

## The leaky bucket

Acquisition fills the bucket. Weak activation, stalled trials, failed
payments, disengagement, and missed follow-up empty it.

Most early teams can see some of those leaks. Their analytics might show the
drop-off and their payment provider might report the failure, but the product
does not reliably respond. The fix lives across scripts, cron jobs, webhook
handlers, a half-configured email tool, and things somebody intended to build
later.

Hogsend closes that response gap. A product event, an absence of activity, a
Stripe webhook, an email interaction, or an in-app action can start or stop a
durable journey across the channels the team already uses.

The leaky bucket is the problem and value narrative. It is not the product
category. The category remains lifecycle automation.

## The April Dunford positioning map

### Competitive alternatives

The real alternatives are not only named competitors:

1. Do nothing yet and accept the leakage.
2. Send one-off emails manually.
3. Accumulate custom cron jobs, queues, and webhook glue in the application.
4. Buy a visual marketing automation platform such as Customer.io, Loops,
   Brevo, Braze, or PostHog Workflows.
5. Assemble separate tools for analytics, messaging, in-app UI, attribution,
   and orchestration, then keep their data in sync.

### Unique attributes

- Lifecycle journeys are TypeScript functions in the product repo.
- Durable waits, event waits, exits, branching, throttles, and digests survive
  deploys and restarts.
- `@hogsend/js`, `@hogsend/react`, and `@hogsend/client` provide a first-party
  event and identity spine. PostHog is optional.
- Buckets, funnels, conversions, attribution, contacts, groups, campaigns, and
  journeys share the same event model.
- One journey can act across email, in-app, SMS, Discord, Slack, Telegram, and
  custom destinations.
- Email and analytics providers are replaceable integrations rather than
  product dependencies.
- The framework is self-hosted and source-available; customer data, sending
  reputation, and infrastructure remain under the team's control.
- Studio observes and operates the system without becoming a separate
  authoring world.
- The CLI, MCP server, blueprints, and bundled skills make the system
  agent-native while retaining code review and promotion-to-code.

### Value those attributes create

- A technical team can ship lifecycle improvements without introducing a
  marketing platform and its parallel workflow.
- Journeys are diffable, testable, reviewable, reusable, and recoverable from
  git history.
- Product behaviour can trigger a response immediately without reverse ETL or
  cohort sync delays.
- The same identity and event stream powers customer communication, product
  surfaces, measurement, and revenue feedback.
- Teams can start with one use case and expand without migrating their
  lifecycle logic out of the product stack.
- Agents can implement and operate more of the system without turning
  production lifecycle behaviour into unreviewed magic.

### Best-fit customers

Technical founders and small engineering teams building product-led software,
especially when they:

- already think in events;
- want engineers or coding agents to own lifecycle work;
- need more than a fixed drip sequence;
- care about control, extensibility, or self-hosting;
- want lifecycle improvements to ship as quickly as product improvements.

### Market category

**Lifecycle automation framework** is the category. **Code-first** is the
decisive qualifier. **For product-led teams** identifies the best-fit context.

This is intentionally different from:

- **Email automation**, which makes Hogsend sound like a sending tool.
- **Marketing automation**, which primes buyers to expect a marketer-operated
  canvas and a CRM-shaped suite.
- **A PostHog lifecycle layer**, which makes an optional integration sound like
  the platform Hogsend depends on.
- **A growth engine**, which communicates ambition but not what the product
  actually does.

## PostHog's role in the story

PostHog is a useful strategic model: it owns a clear category—product
analytics—then expands into adjacent jobs. Hogsend should do the same from a
different centre: own code-first lifecycle automation, then show how its event
spine, messaging surfaces, attribution, funnels, and agent tooling make that
centre more powerful.

The relationship should be expressed as:

> Hogsend works beautifully with PostHog, but it does not require PostHog.

With PostHog configured, events and identities can flow in and lifecycle
events can flow back out. Without it, Hogsend's own SDKs, database, contacts,
groups, journeys, buckets, funnels, and Studio continue to work.

PostHog belongs in the integration and compatibility proof, not in the first
sentence of the category definition.

### What PostHog's positioning teaches us

PostHog currently operates at three levels:

1. **Ambition:** “The new way to build products.”
2. **Audience and mission:** it is here to help product engineers build
   successful products.
3. **Platform:** an all-in-one developer platform or “Product OS” that keeps
   customer context in one place.

That breadth works now because PostHog first established a narrow, legible
category. Its 2020 Hacker News launch was simply
[“open-source product analytics”](https://news.ycombinator.com/item?id=22376732).
PostHog itself says that phrase was instrumental in reaching its first 1,000
users. Its current [About page](https://posthog.com/about) and
[GitHub README](https://github.com/PostHog/posthog) can now lead with building
successful products because the market already understands the product
analytics foundation underneath.

The implication for Hogsend is:

- Do not borrow PostHog's present-day breadth before earning category clarity.
- Launch and explain the product with the crisp category **code-first lifecycle
  automation**.
- Put the larger product-led-growth ambition around that category rather than
  in place of it.
- Speak to product engineers as a mindset, not only as a formal job title. This
  includes technical founders on Hacker News who own product, code, metrics,
  and customer outcomes themselves.

## “The Next.js for product-led growth”

This is a strong analogy for conversation, launch content, and developer
word-of-mouth. It quickly communicates framework, composability, conventions,
and a code-owned application.

It should not carry the homepage alone. “Product-led growth” covers analytics,
experimentation, pricing, onboarding, virality, and many other jobs, so the
analogy creates curiosity without explaining the product.

Recommended use:

> Think of Hogsend as the Next.js for your customer lifecycle: a framework,
> sensible defaults, and an application you own.

Next.js itself leads with a known category—[“The React Framework for the
Web”](https://nextjs.org/)—before describing everything it enables. TanStack
uses the same pattern: [“The open-source application stack for the
web”](https://tanstack.com/), then “headless, type-safe, composable” and
reliable for agents.

That suggests the Hogsend formula should be equally concrete:

> **Lifecycle automation, in code.**

“The Next.js for your customer lifecycle” is then an effective analogy and
community shorthand, not the burdened first explanation.

## Approved hero direction

### Recommended

> **Your customer lifecycle belongs in your repo.**
>
> Hogsend is lifecycle automation in TypeScript for product-led teams. Written
> by you—or your coding agent. Reviewed in a PR. Shipped like the rest of your
> product.

This combines the strongest belief with the clearest category and the actual
technical differentiator.

The outcomes should sit immediately beneath it, in a short proof line rather
than another paragraph:

> Onboarding. Trial conversion. Payment recovery. Retention. Win-back. Across
> email, in-app, SMS, Discord, and more.

### Alternative: lead with speed

> **Ship your product-led lifecycle in an afternoon.**
>
> Typed journeys, first-party events, and every channel in one repo—written by
> you or your coding agent.

This makes time-to-value explicit, but “in an afternoon” needs a tightly proven
setup path and may sound like a claim about completing the strategy rather than
installing the framework.

### Alternative: lead with category

> **Lifecycle automation, in code.**
>
> Build onboarding, conversion, retention, and win-back journeys in the same
> repo as your product.

This is the most immediately legible and likely the best launch title, package
description, and README opening. It is less ownable as the emotional homepage
headline.

“Make your product react” remains useful as a section heading for the
signal-to-response mechanism. It no longer needs to carry the hero.

## Why agent-written matters

“Agents can write it” is not a novelty bullet. It changes the speed and
economics of adopting lifecycle automation:

1. The agent can read the product's existing events, types, templates, billing
   logic, and conventions.
2. It can author the journey beside that context rather than reconstructing it
   in a separate canvas.
3. Type checking and tests catch invalid events, templates, branches, and
   assumptions before deployment.
4. The founder reviews an ordinary diff instead of trusting an opaque AI action
   inside a third-party dashboard.
5. Git records exactly what changed, why, and what version ran.
6. The same agent can inspect run data, propose an improvement, and produce the
   next reviewable change.

The message is therefore not “AI runs your growth automatically.” It is:

> **Your coding agent can build the lifecycle. You still own the code and the
> decision to ship it.**

Canvas products can add copilots. They cannot easily reproduce the combination
of application context, plain TypeScript, compile-time contracts, tests, git,
and the team's existing deployment process without becoming code-first
themselves.

This is why Hogsend can credibly claim to be the fastest way for a technical
team to start and improve a product-led lifecycle. The speed comes from agents,
defaults, and scaffolding; the confidence comes from code review and ownership.

Do not lead with “find product-market fit.” Hogsend helps teams run experiments
and improve activation, conversion, and retention, but product-market fit also
depends on market selection, discovery, product quality, pricing, and demand.
The narrower promise is more credible and more actionable.

## Message hierarchy

Every important surface should tell the story in this order:

1. **Belief:** your customer lifecycle belongs in your repo.
2. **Category:** lifecycle automation in TypeScript.
3. **Problem:** the product sees customer signals but fails to respond, so
   activation, conversion, and retention leak.
4. **Agent advantage:** you or your coding agent writes a typed, tested change;
   you review the diff and decide whether to ship it.
5. **Mechanism:** events enter one identity spine; durable journeys decide what
   happens; the right action goes out on the right channel.
6. **Outcomes:** activate new users, convert trials, recover revenue, retain
   customers, and re-engage the people drifting away.
7. **Why Hogsend:** TypeScript, first-party events, durable execution,
   cross-channel components, provider choice, Studio, agents, and self-hosting.
8. **Proof:** working recipes, concise code, the scaffold, screenshots, and the
   live Studio.
9. **Compatibility:** PostHog, Resend, Stripe, Twilio, Discord, Segment, and the
   rest of the stack.

Features support the story; they should not become the story.

## Landing-page implications

The current landing page asks visitors to understand the product through a
live demo and then classifies Hogsend as a PostHog layer before establishing
the problem. The revised narrative should be:

1. **Hero:** short promise, category, outcome, quickstart.
2. **Problem:** the leaky lifecycle—acquisition is expensive, but products fail
   to respond when users stall, drift, or fail to pay.
3. **How it works:** signal in → durable decision → action out → outcome back
   into the event stream.
4. **Jobs:** onboarding, trial conversion, payment recovery, retention,
   win-back, referral, and community engagement.
5. **Why code:** reviewable TypeScript, durable execution, tests, git, and
   agent-assisted implementation.
6. **What ships:** SDKs, journeys, channels, UI components, identity, Studio,
   measurement, and operational tooling.
7. **Product proof:** code example followed by Studio screenshots and the live
   demo.
8. **Works with your stack:** PostHog as the leading analytics integration,
   alongside first-party SDKs and other sources and destinations.
9. **Ownership and economics:** self-hosted, provider choice, no per-contact
   tax.
10. **Start building:** scaffold command and deployment path.

Specific structural changes implied by this positioning:

- Replace the PostHog-led hero subhead.
- Move the current PostHog pitch much lower and recast it as an integrations
  section.
- Move the existing problem section directly beneath the hero and rewrite it
  around lifecycle leakage rather than a missing PostHog feature.
- Keep a hero link to the demo, but move the large embedded demo experience
  below the mechanism and use cases.
- Reduce repeated feature sections. The current page has many good individual
  sections but too many competing explanations of what Hogsend is.
- Lead with customer outcomes before the platform inventory.

## README implications

The README should stop opening with “the lifecycle email automation that
PostHog teams actually need.” That sentence permanently frames Hogsend as an
add-on and makes the much broader framework look like scope creep.

Recommended opening shape:

> **Hogsend is lifecycle automation in TypeScript.** Your journeys live in your
> repo, written by you or your coding agent, reviewed in a PR, and shipped like
> the rest of your product.

Follow immediately with the concrete outcomes: onboarding, conversion,
retention, payment recovery, and win-back across email, in-app, SMS, Discord,
and more.

Then:

1. Show the two-command quickstart.
2. Show one short journey that waits for behaviour and stops on conversion.
3. Explain the signal → journey → action loop.
4. Show the major jobs and framework primitives.
5. Explain first-party tracking and optional integrations.
6. Introduce Studio and operational tooling.
7. Give PostHog its own “works beautifully with” section rather than making it
   the premise of the project.

## Language to retire from primary surfaces

- “The lifecycle layer for teams on PostHog.”
- “The lifecycle email automation that PostHog teams actually need.”
- “PostHog tells you what users do; Hogsend is the bit in the middle.”
- “Built for teams who picked PostHog and Resend.”

These can survive in PostHog-specific integration and comparison pages, where
that context is relevant.

Avoid using “growth engine” without an immediate concrete explanation. Avoid
using “Next.js for product-led growth” as the only explanation. Avoid leading
with the complete phrase “code-first lifecycle automation framework for
product-led teams” every time; it is the internal category definition, not the
only piece of copy.

## The ten-second test

After ten seconds on the homepage, a technical founder should understand:

1. Hogsend automates what happens across the customer lifecycle.
2. It reacts to real product behaviour.
3. The logic lives in TypeScript and in their repo.
4. They or their coding agent can author it through a reviewable git workflow.
5. It can act across multiple channels.
6. PostHog is supported, not required.

If the page communicates those six things, the positioning is working.
