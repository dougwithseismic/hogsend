# PRD 11 — Lead the homepage with the wedge

## Goal

The first screen of hogsend.com should tell the buyer in `docs/MARKET.md` (a
technical founder or product engineer at a product-led software company) who
Hogsend is for, what it does for them, and why they would pick it over a canvas
tool or a hand-rolled stack. It should do that with one call to action. The
hero said "Superpowers for growth engineers" and offered three equal
actions. The launch bar also asks for green Core Web Vitals on the landing page
and no horizontal overflow at 360–1440px on landing, pricing and the docs home.

## Locked decisions

- The copy follows "Our wedge" in `docs/MARKET.md`: typed journeys in your
  repo, reviewed in a pull request and checked by CI; plus the batteries a DIY
  stack lacks (exactly-once sends, unsubscribe and suppression, tracking,
  identity) on infrastructure you own.
- No competitor is named on the page; that needs the owner's approval. No
  filler words ("superpowers", "supercharge", "seamless", "unlock").
- Keep the visual system (#050101 ground, #F64838 accent, white ramp, Inter
  Display headline, ds components). Remove no page sections.
- One primary call to action: the copyable `pnpm dlx create-hogsend@latest`,
  firing the same `docs.code_copied` event with `snippet` as before. The
  Railway deploy moves to the Get started section, "View docs" becomes one
  quiet text link, and the nav's "Start building" becomes an outline button on
  the homepage only.
- Measure on a local production build (`next build`, standalone server on port
  3110) with Lighthouse 12.8.2 on Chrome 158, mobile and desktop. Run both
  simulated throttling (Lantern, three runs) and applied DevTools throttling
  (same Slow 4G / 4x CPU profile, real timings), and record both.

## Acceptance criteria

- WHEN a visitor loads `/` at 390×844 or 1440×900 THEN the first screen SHALL
  show who it is for, the outcome, why Hogsend and exactly one primary call to
  action, and the call to action SHALL NOT sit under the first-visit consent
  card.
- WHEN the hero renders THEN it SHALL NOT name a competitor or use
  "superpowers", "supercharge", "seamless" or "unlock".
- WHEN the install command is clicked THEN it SHALL be copied and SHALL emit
  `docs.code_copied` with `snippet: "pnpm dlx create-hogsend@latest"`.
- WHEN Lighthouse runs against the production build with applied throttling
  THEN mobile and desktop SHALL report LCP < 2.5 s, CLS < 0.1 and TBT < 200 ms.
- WHEN `/`, `/pricing` or `/docs` render at 360, 390, 768, 1024, 1280 or
  1440px THEN the document's `scrollWidth` SHALL equal the viewport width.
- WHEN `/?hero=<variant>` is requested THEN that variant SHALL render with
  `noindex`, and `/` itself SHALL be served statically.

## Tasks

1. Rewrite the hero around the wedge, with one CTA (`wired-hero.tsx`,
   `nav.tsx` `quietCta`, Railway link moved into `PsGetStarted`, page
   metadata).
2. Make the homepage static: drop the `searchParams` read, serve previews from
   `/hero-preview/[variant]` behind a `/?hero=` rewrite.
3. Cut the first-screen font bytes: Latin subsets of Inter Display, and stop
   preloading Montserrat.
4. Skip rendering below-the-fold sections until they near the viewport
   (`content-visibility`).
5. Measure before and after; sweep overflow at six widths on three pages.

## Implementation Notes

### Copy

| | Before | After |
| --- | --- | --- |
| Above the headline | "New course · Measure → Keep → Grow with PostHog" pill linking to the course | "For product engineers and technical founders" (plain text, not a link) |
| Headline | Superpowers for growth engineers. | Lifecycle messaging as code in your repo. |
| Subhead | Hogsend is a TypeScript framework for growth teams that code. Identify and enrich the people on your product, react to their events, message them where they are, and measure what moved. | When a customer signs up, stalls in a trial or stops paying, Hogsend runs the follow-up. Journeys go through pull requests and CI like the rest of your code. Exactly-once sends, unsubscribes and suppression are built in, on infrastructure you own. |
| Calls to action | Copy box for `pnpm dlx create-hogsend@latest`, "Deploy on Railway →", "View docs →"; white "Start building" in the nav | The whole command box is the button (copies, same event). Below it: "Scaffolds the app, Docker services and starter journeys. Read the quickstart →". Nav "Start building" is an outline. Railway is in Get started with `TrackDeployClick placement="home-get-started"` |
| Pillars | Code-first · Full-funnel · Event-powered · Measure impact | Typed journeys in your repo · Exactly-once sends · Unsubscribe and suppression · On infrastructure you own |
| `<title>` | Hogsend — The growth stack for teams that code | Hogsend — Lifecycle messaging as code in your repo |

The eyebrow answers who it is for. The subhead's first sentence is the
outcome. The headline plus the batteries sentence say why Hogsend: wedge
point 1 and wedge point 2. The course stays linked from the footer.

The subhead is five lines at 1440 and 390. Seven lines pushed the command under
the consent card (fixed bottom-left, about 280px tall on a first visit) at
1440×900, so the copy was cut and the top padding tightened.

### Core Web Vitals (local production build, `/`)

Simulated is Lantern; applied is DevTools throttling with the same profile.
The after rows are medians of three runs. The before rows are medians of
three simulated runs, and the better of two applied runs.

| Run | Score | FCP | LCP | CLS | TBT |
| --- | --- | --- | --- | --- | --- |
| Mobile, applied, before | 75 | 3.76 s | 3.76 s | 0.061 | 23 ms |
| Mobile, applied, after | 93 | 2.13 s | 2.13 s | 0.057 | 27 ms |
| Desktop, applied, before | 99 | 0.56 s | 0.56 s | 0.012 | 0 ms |
| Desktop, applied, after | 100 | 0.13 s | 0.13 s | 0.012 | 0 ms |
| Mobile, simulated, before | 73 | 2.40 s | 6.98 s | 0.001 | 9 ms |
| Mobile, simulated, after | 76 | 2.10 s | 6.16 s | 0.001 | 8 ms |
| Desktop, simulated, before | 96 | 0.52 s | 1.35 s | 0.000 | 0 ms |
| Desktop, simulated, after | 98 | 0.48 s | 1.09 s | 0.000 | 0 ms |

Simulated mobile LCP stays red, and the main reason is localhost. Lantern
builds its LCP estimate from every request that finished before the paint it
observed. On localhost the whole page (about 800 KB: document, CSS, fonts and
roughly 520 KB of script) arrives in under 100 ms, before that first paint. So
all of it is charged to LCP over a simulated 1.6 Mbps HTTP/1.1 link. Applied
throttling measures the same profile in real time. There, LCP lands right after
the main stylesheet finishes, with scripts still downloading. A PageSpeed
Insights run against production after deploy is the confirming number.

What changed, in the order measured:

- **The homepage is static.** It read `searchParams` for the `?hero=` preview,
  which made every request a full dynamic render. Local TTFB was about 450 ms,
  and the response was a 265 KB gzipped stream. It is now ISR, regenerated
  hourly (the same cadence as `getEngineVersion`). Local TTFB is about 7 ms and
  the gzipped document is about 156 KB. Previews still work at the same URLs:
  a `beforeFiles` rewrite with a `has: query` condition sends `/?hero=<x>` to
  `/hero-preview/<x>`, which forces the variant and sets `noindex`. The
  World Cup final check now runs at each regeneration.
- **First-screen fonts went from 5 preloads (323 KB) to 4 (126 KB).** Inter
  Display Regular and Medium are now Latin subsets made with pyftsubset: 26 KB
  and 28 KB, down from about 110 KB each. The subsets keep the arrows, ticks
  and shapes the copy uses, plus kerning, ligatures and tabular figures. The
  full files stay for the Remotion pipeline. Montserrat is no longer
  preloaded. It sets only the nav wordmark and the section headings below the
  hero, and the browser still fetches it when the wordmark is laid out.
- **Below-the-fold sections skip rendering.** `main > section.tw-section` gets
  `content-visibility: auto` with `contain-intrinsic-size: auto 1000px`.
  Sections with a blend layer (thermal, halftone, aurora, `mix-blend-*`) are
  excluded. Containment isolates a section, so a blend layer would composite
  against the section instead of the page, and the closing CTA's halftone
  visibly changed until they were excluded. Seven of the eleven below-fold
  sections qualify (manifesto, agents, product demo and closing CTA carry
  blend layers); the hero and the stack deck are untouched. Each section's
  seam was screenshotted with the rule on and off at 1440 and 390. The pairs
  match apart from sub-pixel text antialiasing and running animations. The
  FAQ's sticky column pins identically with the rule on and off. `/#use-cases`
  still lands at the top of its section, and the remembered sizes match the
  real heights after a scroll-through.

### Horizontal overflow

`scrollWidth === clientWidth` on every page at every width. A second pass
looked for anything cut off by the homepage `main`'s `overflow-x-clip`, which
would hide real overflow from `scrollWidth`. It found nothing at 360 or 390.

| Page | 360 | 390 | 768 | 1024 | 1280 | 1440 |
| --- | --- | --- | --- | --- | --- | --- |
| `/` | ok | ok | ok | ok | ok | ok |
| `/pricing` | ok | ok | ok | ok | ok | ok |
| `/docs` | ok | ok | ok | ok | ok | ok |

No overflow fixes were needed.

### Not done / follow-ups

- **The consent card still covers the command on short viewports.** On a
  first visit the card covers it at 1366×768, 1280×800, 1024×768 and
  360×780. It was the same before this change: at 1440×900 the old command sat
  just above the card. It is clear at 390×844, 768×1024, 1440×900 and
  1920×1080. Fixing the rest means changing the consent surface. Options:
  show it after the first scroll on the homepage, or dock it bottom-right
  from `md` up and keep it clear of the done-for-you card. That is the owner's
  decision, since the card was a deliberate GDPR design (#343).
- `posthog-js` (about 63 KB gzipped) is still imported eagerly by
  `lib/analytics.ts`. It evaluates after first paint, so it is outside the LCP
  path, but it competes for bandwidth on a slow link. Loading it with a
  dynamic import means touching `analytics.ts`, `feature-flags.ts`, the boot
  component and the devtools panel.
- The document is still about 156 KB gzipped. About 1.0 MB of it decoded is
  the inline RSC payload, and Shiki token trees are 47 KB gzipped of that,
  serialized once as HTML and again as React elements. Code panels that load
  their highlighted HTML after mount would cut this the most.
