# The Hogsend Course: Measure, Keep, and Grow

A start-to-finish course on running a growth program with **PostHog + Hogsend** — from
instrumenting your first event to driving paid traffic into an audience you own.

This is written for the person who builds: a technical founder, a developer, or a
consultant standing this up for a client. It assumes you can read TypeScript and
deploy a service. It does not assume you have ever set up analytics, run an ad, or
written a lifecycle email.

---

## The one idea this course is built on

Most teams grow by pouring more traffic into the top of the funnel. That works
until you look at the bottom and find the bucket is leaking — people sign up, never
reach value, and quietly disappear. Pouring faster just spills faster.

This course teaches the opposite order:

1. **Measure** what's happening (PostHog) so you can see the leaks.
2. **Keep** the users you already have (lifecycle messaging with Hogsend) so the
   bucket stops leaking.
3. **Grow** by driving traffic — and capturing every visitor into an audience you
   own (email, Discord, Telegram), so you never have to pay to reach them twice.

Acquisition is the *last* lever, not the first. By the time you turn it on, every
dollar lands in a bucket that holds water.

---

## What you'll be able to do by the end

- Set up PostHog from scratch and read the four charts that actually matter.
- Define your activation metric — the "aha moment" that predicts whether a user stays.
- Build a lifecycle email program in code: welcome, onboarding, win-back, dunning,
  referral — each triggered by real product behaviour.
- Run Meta ads that track conversions accurately even with ad blockers and iOS in
  the way.
- Turn ad clicks into verified emails and linked Discord/Telegram accounts, and turn
  those into a referral loop that lowers your cost of growth over time.

---

## The chapters

| # | Chapter | What it covers |
|---|---------|----------------|
| 1 | [What PostHog is, and why you want it](./01-what-is-posthog.md) | The product suite, why you measure at all, US/EU, what it costs |
| 2 | [AARRR and the leaky bucket](./02-aarrr-and-the-leaky-bucket.md) | The five metrics that matter, the aha moment, your North Star |
| 3 | [Instrument PostHog from zero](./03-instrument-posthog.md) | Install, identify users, the events to track first, beating ad blockers |
| 4 | [What to look at every day](./04-your-daily-dashboard.md) | The daily checklist and what each chart is telling you |
| 5 | [Lifecycle messaging: which emails, in what order](./05-lifecycle-messaging.md) | Which to build first, why touch-points matter, plugging the bucket |
| 6 | [Building the lifecycle in Hogsend](./06-building-lifecycle-with-hogsend.md) | Journeys as code: welcome, nudge, win-back, dunning, referral |
| 7 | [Driving traffic](./07-driving-traffic.md) | Meta ads, Pixel vs Conversions API, server-side tracking, audiences |
| 8 | [The owned-audience flywheel](./08-owned-audience-identity-flywheel.md) | Discord/Telegram linking, email verification, referral loops |
| 9 | [Putting it all together](./09-putting-it-all-together.md) | The full funnel and a 30/60/90-day plan |

Work through them in order the first time — each chapter assumes the one before it.
After that, treat it as a reference.

---

## How to read the numbers in this course

Growth writing is full of confident statistics with shaky origins. Where this course
quotes a figure, it tells you how much to trust it:

- **Well-attested** — consistent across several independent sources. Use it.
- **Directional** — the mechanism is real but the exact number is a single source or
  a vendor's blog. Trust the direction, not the decimal.
- **Folklore** — a famous number with a fuzzy paper trail (often an old DMA/Experian
  study). Quoted for colour, not as proof.

The famous "magic numbers" (Facebook's *7 friends in 10 days*, Slack's *2,000
messages*) are rally cries, not laws — they describe an average, and the real lesson
is the *method* used to find them, not the numbers themselves. Chapter 2 covers this
in full.

---

## A note on where Hogsend fits

PostHog **detects** — it collects events, identifies people, and shows you the
funnels and retention curves. Hogsend **acts** — it runs the lifecycle journeys
(emails, Discord/Telegram messages) that move people through those funnels, and it
fires events back so the loop is measurable. You'll see both throughout; chapters
1–4 lean on PostHog, chapters 5–8 lean on Hogsend, and chapter 9 ties them together.

→ Start with **[Chapter 1: What PostHog is, and why you want it](./01-what-is-posthog.md)**.
