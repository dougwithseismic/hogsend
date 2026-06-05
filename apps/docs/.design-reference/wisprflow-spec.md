# Hogsend docs — "Wispr Flow" redesign spec (SPIKE)

This is the **single source of truth** for restyling `apps/docs` to look EXACTLY like
https://wisprflow.ai/ — its design system, color, typography, and section layout —
while keeping Hogsend's real product content/copy. Every component must obey this
spec so the parallel rebuild stays coherent. When in doubt, match Wispr Flow.

Wispr Flow is a **warm, light, editorial** site: a cream canvas with huge serif
headlines, rounded dark/teal "panel" cards stacked on the cream, playful spot
colors, hand-drawn doodle accents, and bordered rounded-rectangle buttons.
We are NOT keeping the old dark "studio" aesthetic. We are flipping the whole
site to light/cream.

---

## 1. Color system (exact hex — use these token names)

Defined in `app/global.css` `@theme` as Tailwind color tokens. Utility names in **bold**.

| Token            | Hex        | Utility            | Role                                              |
|------------------|------------|--------------------|---------------------------------------------------|
| lumen (cream)    | `#ffffeb`  | **lumen**          | Primary page background (body). The canvas.       |
| lumen-dark       | `#e4e4d0`  | **lumen-dark**     | Cream borders / subtle dividers on light.         |
| ink (vast)       | `#1a1a1a`  | **ink**            | Primary text + dark panel background.             |
| ink-soft         | `#8a8a80`  | **ink-soft**       | Muted serif clause in hero (two-tone headline).   |
| fathom (teal)    | `#034f46`  | **fathom**         | Teal panel background + testimonial cards.        |
| glow (amber)     | `#ffa946`  | **glow**           | Doodles, icon accents, highlights, arrows.        |
| pulse (wine)     | `#7f1c34`  | **pulse**          | Rare deep accent (badges/error-ish).              |
| dawn (lavender)  | `#f0d7ff`  | **dawn**           | Primary button fill + tag chips.                  |
| mint             | `#cef5ca`  | **mint**           | Success tag fill; `text-success` = `#114e0b`.     |
| paper-white      | `#ffffff`  | **paper**          | White cards/buttons on cream.                     |

Text-on-dark / text-on-teal = `#ffffeb` (lumen) or pure white `#fff`. Muted on
dark = `text-lumen/60`. Muted on cream = `text-ink/60`.

**Spot-color rule:** the page is mostly cream + ink. Use lavender (buttons/tags),
amber (doodles/icons), teal (1–2 panels + testimonials), mint (success chips)
sparingly as *playful punctuation* — never large flat fills beyond the panels.

---

## 2. Typography

Three faces, wired via `next/font/google` in `app/layout.tsx`, exposed as CSS vars
and mapped in `@theme`:

- **Display / headings → EB Garamond** (serif). `--font-display`, utility `font-display`.
  Weight **400** (light serif). This is the hero face. ALL `h1–h4` render in it.
- **Body / UI → Figtree** (sans). `--font-sans`, utility `font-sans`. Default body font.
- **Code → Geist Mono** (keep). `--font-mono`, utility `font-mono`. Eyebrows + code only.

Heading scale (match Wispr; use responsive clamps):
- **Hero h1**: `clamp(3.25rem, 9vw, 7.5rem)` (max 120px), `font-display`, weight 400,
  `line-height: 0.9`, `letter-spacing: -0.04em`, centered. **Two-tone**: first clause
  `text-ink-soft` (#8a8a80), second clause `text-ink`.
- **Section h2**: `clamp(2.25rem, 4.5vw, 4rem)`, `font-display`, weight 400,
  `letter-spacing: -0.02em`, `line-height: 1.0`.
- **h3 (card/feature title)**: `1.75rem–3rem` serif.
- **Body**: Figtree `1.125rem` (`text-lg`), `line-height: 1.5`, `text-ink/70`.
- **Eyebrow**: Geist Mono, `0.6875rem`, uppercase, `letter-spacing: 0.08em`, often
  with a small colored square (amber/teal/lavender) before it.

Serif headlines are the #1 signature. They are LIGHT weight and TIGHT tracking.
Never bold them. Never set headings in Figtree.

---

## 3. Layout: the "stacked rounded panels on cream" model

The whole site is a vertical stack on the **cream** body. Sections are one of three
panel kinds:

1. **Cream / open** (`bg-transparent`, inherits body): hero, comparison, feature
   splits, FAQ, self-hosted. Text = ink.
2. **Dark panel** (`bg-ink` #1a1a1a), **rounded** `rounded-[2.5rem] md:rounded-[4rem]`,
   text = lumen. Used for the "integrations" and "made for the way you work" sections.
3. **Teal panel** (`bg-fathom` #034f46), rounded same, text = lumen. Used for the
   client/logos strip and testimonials.

Rounded panels sit INSIDE the cream canvas with the cream showing as a margin/gutter
around them. Implement via the `Section` primitive `tone` + `panel` props (see §5).
Panel radius observed on Wispr: 40px / 64px / 80px → use `rounded-[2.5rem]` small,
`rounded-[4rem]` large. Big panels may use horizontal inset (`mx-4 md:mx-6`) so the
cream frames them; full-bleed cream sections use the normal container.

- **Container**: keep `.container-page` (max-width 1320px, `px-6`). Wispr content
  frame is ~1300px — keep ours.
- **Section vertical rhythm**: generous. `py-24 md:py-32` (Wispr large padding = 8rem).
- **Corner radius on inner media/cards**: 16–24px (`rounded-2xl`/`rounded-3xl`).

---

## 4. Buttons (exact)

Observed primary button: `bg #f0d7ff`, text `#1a1a1a`, **border 2px solid #1a1a1a**,
**border-radius 12px**, padding `16px 24px`, Figtree **600**, 16px, with a leading icon.
Buttons are rounded-RECTANGLES with a hard 2px ink border — NOT pills, NOT sharp.

Restyle `components/ds/button.tsx` variants:
- **`accent` (primary)**: `rounded-[12px] border-2 border-ink bg-dawn text-ink font-sans font-semibold px-6 py-3.5 text-base` + optional leading icon (Apple→swap for a relevant lucide icon, e.g. `Terminal`/`ArrowRight`). Hover: `hover:brightness-95` / slight translate.
- **`solid`**: same shape, `bg-ink text-lumen border-2 border-ink` (dark fill). On dark panels use `bg-lumen text-ink`.
- **`outline` / secondary**: `rounded-[12px] border-2 border-ink bg-paper text-ink` on cream (white fill, ink border); on dark panels `bg-transparent border-lumen/80 text-lumen`.
- Drop the old mono-uppercase styling. Buttons are **Figtree, sentence case, weight 600**.
- Keep the `href`/`external`/`tone`/`icon` API so existing call sites keep working.

---

## 5. Restyled primitives (ownership: foundation agents)

Keep every existing exported name + prop so call sites don't break. Repaint internals.

- **`section.tsx`** — `Section({ tone, panel?, id, className, containerClassName })`.
  - `tone: "cream" | "dark" | "teal" | "light"` (map old `"light"`→cream, `"dark"`→dark panel).
  - `panel` (default true for dark/teal): wraps content in a rounded panel
    (`rounded-[2.5rem] md:rounded-[4rem]`, horizontal inset gutter so cream frames it).
  - `cream`/`light` tone = transparent bg, ink text, normal container (no panel).
  - `SectionHeading` — heading now `font-display` serif `clamp(2.25rem,4.5vw,4rem)`
    weight 400 tracking-tight; eyebrow = mono chip w/ colored square; subtitle
    Figtree `text-ink/65` (or `text-lumen/65` on panels). Keep `eyebrow/title/subtitle/tone/align`.
- **`badge.tsx`** — `Eyebrow`: mono uppercase 11px with a small **amber** (cream)/**lavender**
  (dark) square before it, no heavy pill. `TagPill`: `rounded-full bg-dawn text-ink` on cream,
  `bg-lumen/10 text-lumen` on dark; a `mint` success variant.
- **`card.tsx`** — cards become `rounded-3xl` cream surfaces: `bg-paper border-2 border-ink/10`
  on cream; on dark panels `bg-lumen/[0.04] border border-lumen/10`. `FeatureCard` keeps API;
  title serif, body Figtree. Drop corner-tick "registration" motif unless it reads as playful.
- **`decor.tsx`** — `Wordmark`: a GIANT ink wordmark "Hogsend" (serif or the logo bars)
  rendered huge in the footer like Wispr's giant "Flow". Add the bar-style mark if easy.
- **`mockup.tsx` / `code-highlight.tsx` / `tabs.tsx` / `process.tsx` / `faq.tsx` (ds) /
  `marquee.tsx` / `fx.tsx`** — repaint for the light system: code mockups become dark
  `bg-ink` rounded-2xl panels (code stays dark — that's fine and matches Wispr's dark inset
  cards) with `font-mono`; their chrome/borders use ink/lumen; showcase tabs use lavender
  active state; FAQ accordion uses ink borders on cream; marquee/logo rows tint logos in ink.

### New shared motif components (foundation agent A2 creates these in `components/ds/`)
These are the Wispr "signature" decorations. Keep them small, inline-SVG, `aria-hidden`.

- **`doodle.tsx`** — a set of hand-drawn amber accents: `Sunburst` (radiating ticks, like
  Wispr places over the "I" in "AI Auto Edits"), `Squiggle` (wavy underline), `LoopArrow`,
  `Star`. Stroke = `currentColor`, default amber. Used to punctuate serif headings.
- **`curved-text.tsx`** — text rendered along an SVG circular/arc `<textPath>` (the hero
  centerpiece on Wispr is rotating text on a path). Props: `text`, radius, className.
- **`dotted-circle.tsx`** — a dotted circular/looping stroke path (CTA + hero motif),
  inline SVG with `stroke-dasharray`.
- **`pulse-pill.tsx`** (optional) — a small rounded pill with an animated indicator,
  Hogsend's analog to Wispr's waveform pill (e.g. a tiny "● event → ✉ send" chip or a
  terminal `$` chip). Keep subtle.

---

## 6. Section-by-section layout (keep Hogsend copy; restyle to Wispr)

Page order in `app/(home)/page.tsx` — produce the cream → dark → teal → cream rhythm:

1. **SiteNav** (`site-nav.tsx`) — FLOATING top bar, transparent over cream, turns to
   `bg-lumen/80 backdrop-blur` + subtle `border-b border-ink/10` on scroll. Layout: logo
   left ("Hogsend" + bar mark), centered menu (Docs · Getting Started · Compare · GitHub),
   right = **primary lavender bordered button** ("Get started" → `/docs` or
   "npx create-hogsend"). Text = ink. Mobile: hamburger → cream sheet.

2. **Hero** (`hero.tsx`) — cream, centered. Two-tone serif h1 (homage to "Don't type,
   just speak"): **"Don't drag-and-drop,"** in `text-ink-soft` + **"just write code."**
   in `text-ink`. Subtitle (Figtree, ink/70): keep Hogsend's "The voice…"→ e.g. "Lifecycle
   email automation as plain TypeScript — journeys and buckets as functions, not YAML or a
   canvas." Primary button "Get started" (lavender) + secondary "Read the docs" (white/ink).
   Below the buttons: small caption "Open source · self-hosted · PostHog + Resend".
   Centerpiece: a **CurvedText** ring of Hogsend copy (event names / journey steps) wrapping
   a **PulsePill** / small terminal chip (`pnpm dlx create-hogsend`). Keep it light + airy.

3. **Integrations panel** (`logo-strip.tsx` → upgrade) — **DARK rounded panel** (#1a1a1a).
   Serif h2 "Works in every part of your stack" + sub "PostHog in, Resend out — events,
   journeys, and sends wired together." Arc / row of integration logos (PostHog, Resend,
   Stripe, Hatchet, Railway, TypeScript) using existing `BrandLogo`, tinted for dark.
   Optionally a dark code/terminal mockup on the side. Platform-style pills row
   (e.g. "PostHog", "Resend", "Stripe", "Webhooks") rounded-full bordered.

4. **Clients/logos** (can live in `logo-strip.tsx` or a small block) — **TEAL rounded panel**
   (#034f46). Centered serif line "Built for teams shipping on PostHog + Resend" + the
   existing logo marquee, tinted lumen.

5. **Building blocks** (`building-blocks.tsx`) — cream. Lead with a **comparison** homage to
   Wispr's "45 wpm vs 220 wpm": two cards — left small cream/bordered card "Drag-and-drop
   canvas" (the slow/old way), right larger card "Hogsend · TypeScript" (the fast way, can use
   a teal or image-style bg). Then keep the journeys/wait/tracking/buckets showcase, but as
   **feature splits**: serif h3 with an amber doodle accent, Figtree body, and a dark code
   mockup beside it (`CodeHighlight`/`CodeMock`). Use `TabbedShowcase` restyled, or stack
   feature splits alternating image side. Preserve all the real code samples.

6. **Powered by Hatchet** (`powered-by.tsx`) — **DARK rounded panel**. Hatchet logo, serif h2,
   the three durability pillars (icon squares amber-tinted), and the "Learn more" link.

7. **Use cases** (`use-cases.tsx`) — **DARK rounded panel** "Made for the way you ship" /
   keep "The emails every product should send". 3-up `FeatureCard` grid, restyled (serif
   titles, lavender/amber icon chips), on the dark panel. Add a doodle illustration vibe.

8. **How it works** (`how-it-works.tsx`) — cream. `ProcessSteps` restyled: serif step titles,
   dark code/terminal mockups, amber step numbers. Keep the scaffold + journey code.

9. **Studio** (`studio.tsx`) — cream OR teal panel. Serif h2 "See everything that goes out",
   the 4 screenshots in rounded-2xl framed cards (2x2), mono caption labels w/ amber square.

10. **Self-hosted** (`self-hosted.tsx`) — cream. Two-column: left serif heading + pillars
    (ink icon chips), keep "Self-hosted, open source, no lock-in".

11. **Testimonials** (NEW `testimonials.tsx`) — **TEAL panel**, 2x2 grid of teal cards
    (slightly lighter teal or bordered), each: serif headline (e.g. "From config to code"),
    a short quote, avatar + name + role, and a ↗ arrow top-right. Use plausible Hogsend-
    flavored quotes from devs/founders (clearly illustrative). Homage to Wispr testimonials.

12. **FAQ** (`faq.tsx`) — cream. Keep the sticky-left layout; serif heading; accordion w/
    ink hairline borders on cream; lavender focus. Keep the 5 real Q&As.

13. **Final CTA** (NEW `final-cta.tsx`) — full-bleed cream→ or a dark/teal panel with a HUGE
    serif headline homage to "Start flowing": **"Start sending"** + a **DottedCircle** motif,
    primary lavender button "Get started" + secondary "Read the docs". Big and airy.

14. **Footer** (`site-footer.tsx`) — cream. Serif column headings (Product / Resources /
    Community — keep existing links), then a GIANT ink "Hogsend" wordmark (like Wispr's giant
    "Flow", with the bar mark), bottom row: © Hogsend 2026 · links · social icons (GitHub, npm, X).

---

## 7. Fumadocs `/docs` theme (foundation agent A1)

Wispr is light, so flip the docs UI to a cream/light theme. In `global.css`, replace the
dark `--color-fd-*` overrides with a LIGHT mapping:
- `--color-fd-background: #ffffeb` (lumen), `--color-fd-foreground: #1a1a1a`
- muted/card surfaces = ink at low alpha on cream; borders `#1a1a1a14`
- `--color-fd-primary: #034f46` (teal) or keep lavender accent; active links/TOC teal/amber
- popover/card backgrounds `#ffffff`
- Switch `app/layout.tsx` html OFF the `dark` class (light theme). Body `bg-lumen text-ink`.
- Keep `RootProvider theme={{ enabled: false }}` but now light. Headings in docs = EB Garamond.
- Import a light fumadocs preset if needed; code blocks keep a dark shiki block (fine).

---

## 8. Hard rules (DO / DON'T)

DO:
- Use ONLY the tokens in §1 (utilities `lumen`/`ink`/`fathom`/`glow`/`dawn`/`mint`/`paper`/`ink-soft`).
- Make every heading `font-display` (EB Garamond), weight 400, tracking-tight.
- Make buttons `rounded-[12px] border-2 border-ink`, Figtree 600, sentence case.
- Keep all existing Hogsend product copy & code samples (you may lightly reword for the homage).
- Keep exported component names + props stable (page + cross-imports must keep compiling).
- Respect `prefers-reduced-motion`; keep `Reveal` subtle.

DON'T:
- Don't keep the old black `bg-ink` *body* / dark-first studio look as the global canvas.
- Don't use the green `#9ff690` accent, the dot-grid, aurora-beam-green, or barcode/corner-tick
  motifs (replace green with amber/teal/lavender). Remove `--color-accent` green usage.
- Don't bold serif headings. Don't set headings in Figtree. Don't make buttons pills or sharp.
- Don't break TypeScript types (`pnpm check-types` must pass) or imports.

The North Star: open https://wisprflow.ai/ in your mind — cream paper, huge light serif,
rounded dark/teal cards, lavender bordered buttons, amber doodles. Make Hogsend feel like
that, with Hogsend's content.
