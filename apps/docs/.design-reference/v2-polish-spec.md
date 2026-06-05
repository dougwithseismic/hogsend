# Hogsend docs — v2 polish spec (SEO · JSON-LD · dark mode · a11y)

Builds on `wisprflow-spec.md` + the shipped neapolitan-ice-cream + purple palette.
This pass: production SEO, JSON-LD structured data, a tasteful DARK MODE, and an
all-round quality polish. Keep the light neapolitan look as the default; do not
regress it. Stack: Next 16 (app router, standalone server — NOT static export, so
robots.ts / sitemap.ts / opengraph-image.tsx all work), Fumadocs, Tailwind v4,
next-themes (via Fumadocs `RootProvider`).

## Site constants (put in `lib/site.ts`, import everywhere — single source)
- `SITE_URL = "https://hogsend.com"`
- `SITE_NAME = "Hogsend"`
- `SITE_TAGLINE = "Email automation for scrappy product engineers"`
- `SITE_DESCRIPTION = "Hogsend connects PostHog and Resend so the right lifecycle email goes out on its own — journeys and buckets as plain TypeScript, self-hosted and open source."`
- `GITHUB_URL = "https://github.com/dougwithseismic/hogsend"`
- `NPM_URL = "https://www.npmjs.com/package/@hogsend/engine"`
- `OG_IMAGE = "/opengraph-image"` (generated; 1200x630)

## Current palette (LIGHT — the default, do not change the values)
lumen `#fbf3e1` (vanilla canvas) · lumen-dark `#ecdcc2` · ink `#3a2418` (chocolate text + "dark" panels) · ink-soft `#a98d77` · fathom `#f7adc6` (strawberry panel, ink text) · glow `#e8688f` (raspberry accent/doodles) · pulse `#a8385f` · dawn `#c3a0ee` (grape purple button/chips) · mint `#cfe6ad` · paper `#fffaf0` (white cards) · grape `#8b5cf6` (links).

Key structural fact: `lumen` is "the light color" (canvas bg AND text inside dark
panels); `ink` is "the dark color" (body text AND dark-panel bg); `paper` = card
surface; `fathom` = strawberry panel; `dawn` = button; `glow` = accent. Components
are token-driven, so flipping these values under `.dark` flips the whole site.

## DARK MODE — the inverted-panel approach (exact values)
Add a Tailwind v4 dark variant and override the SAME token names under `.dark`, so
the light "dark panels" become light cream panels on a dark espresso canvas (a
coherent "dark neapolitan": espresso base + cream panels + deep-berry + grape).

In `app/global.css`:
1. Add: `@custom-variant dark (&:where(.dark, .dark *));` (so `dark:` utilities work with next-themes' `.dark` class).
2. Add a NON-flipping code-surface token in `@theme` (same in both themes — code windows must STAY dark): `--color-code: #1f150f;`
3. Override tokens under `.dark` (dark espresso canvas, cream text, inverted panels):
   - `--color-lumen: #251913;` (espresso canvas)
   - `--color-lumen-dark: #3a2a1e;`
   - `--color-ink: #f3e9d6;` (warm cream — text + the now-light panels)
   - `--color-ink-soft: #ad9a85;`
   - `--color-fathom: #883f56;` (deep strawberry panel; cream text reads on it)
   - `--color-glow: #f481a4;` (brighter raspberry for dark)
   - `--color-pulse: #d9708b;`
   - `--color-dawn: #8c5fd4;` (deeper grape button; cream text/border read)
   - `--color-mint: #cfe6ad;` (keep light pistachio — used with hardcoded dark-green text)
   - `--color-paper: #2f2017;` (dark card surface)
   - `--color-grape: #c4a7f7;` (brighter grape link)
   - `--color-success: #cfe6ad;` (success text now light, on dark)
4. Split the Fumadocs `--color-fd-*` block: KEEP the light values under `:root`, and
   add a `.dark { --color-fd-* }` dark mapping: fd-background `#251913`,
   fd-foreground `#f3e9d6`, fd-card/popover `#2f2017`, fd-border `rgba(243,233,214,0.12)`,
   muted = cream low-alpha, fd-primary `#c4a7f7`, fd-primary-foreground `#251913`,
   fd-ring `#c4a7f7`. (Currently they live under `:root, .dark` together — separate them.)
5. `html` background: keep `#fbf3e1`; add `html.dark { background-color: #251913; }`.

Component fixes the dark pass must make (most components already flip via tokens —
only fix the EXCEPTIONS):
- **Code/mockup surfaces must stay dark in BOTH themes**: change `bg-ink` → `bg-code`
  in `code-highlight.tsx` and `mockup.tsx` (MockupFrame + CodeMock bezel/window).
  Their inner text already uses lumen-ish tokens; verify shiki stays readable.
- Audit every component for any HARDCODED hex (e.g. `text-[#114e0b]`) or assumptions
  that break in dark; prefer tokens or add a `dark:` utility. Verify contrast both ways.
- The hero pill `shadow-[0_4px_0_0_var(--color-ink)]` and `border-ink` flip fine
  (cream border/shadow on dark) — leave unless it looks wrong.

`app/layout.tsx` (theme provider): re-enable the toggle — `RootProvider` with
`theme={{ enabled: true, defaultTheme: "light", enableSystem: true }}` (Fumadocs wraps
next-themes). Add `suppressHydrationWarning` on `<html>`. Keep fonts.

`components/landing/site-nav.tsx`: add a small theme-toggle button (sun/moon lucide,
`useTheme` from next-themes, `"use client"` already) next to the GitHub icon. Mobile too.

## SEO
`app/layout.tsx` root `metadata` (use `lib/site.ts`):
- `metadataBase: new URL(SITE_URL)`, `title: { default: \`${SITE_NAME} — ${SITE_TAGLINE}\`, template: \`%s · ${SITE_NAME}\` }`, `description: SITE_DESCRIPTION`,
- `applicationName`, `keywords` (lifecycle email, PostHog, Resend, TypeScript, email automation, journeys, self-hosted),
- `openGraph` (type website, url, siteName, title, description, images:[{url:OG_IMAGE,width:1200,height:630,alt}]),
- `twitter` (card summary_large_image, title, description, images),
- `alternates: { canonical: "/" }`, `robots` (index,follow + googleBot maxes),
- `icons` (icon/apple), `manifest: "/manifest.webmanifest"`, `category`.
- Add `export const viewport` with `themeColor` (light `#fbf3e1`, dark `#251913` via media) + colorScheme "light dark".

New route files (own these; they don't exist yet):
- `app/robots.ts` — `MetadataRoute.Robots`: allow all, `sitemap: ${SITE_URL}/sitemap.xml`, host.
- `app/sitemap.ts` — `MetadataRoute.Sitemap`: home `/` + every docs page from
  `source.getPages()` (`${SITE_URL}${page.url}`), sensible `changeFrequency`/`priority`/`lastModified`.
- `app/manifest.ts` — `MetadataRoute.Manifest`: name/short_name Hogsend, description, start_url `/`,
  display standalone, `background_color` `#fbf3e1`, `theme_color` `#fbf3e1`, icons.
- `app/opengraph-image.tsx` — `ImageResponse` 1200x630, on-brand: vanilla `#fbf3e1` bg, big
  chocolate `#3a2418` serif title "Email automation for scrappy product engineers", a small
  raspberry/grape accent + "Hogsend · PostHog → Resend" line + the `pnpm dlx create-hogsend`
  chip. Try to load EB Garamond (fetch the .ttf from a Google Fonts CSS URL at runtime); if the
  fetch fails, fall back to the default serif — must never throw. Export `size`, `contentType`,
  `alt`. (A `twitter-image.tsx` may re-export it.)
- `app/icon.tsx` (or favicon): a simple generated icon (the bar-chart mark on vanilla/chocolate) is fine.

Docs per-page (`app/docs/[[...slug]]/page.tsx` `generateMetadata`): keep title/description from
frontmatter, ADD `alternates.canonical: page.url`, `openGraph`/`twitter` per page, and a sensible
`title` (Fumadocs page title + template applies). Use `lib/site.ts`.

## JSON-LD (structured data)
Create a generic `components/json-ld.tsx` exporting `JsonLd({ data })` that renders
`<script type="application/ld+json" dangerouslySetInnerHTML={{__html: JSON.stringify(data)}} />`
(safe: server-built data, escape `<`).
Create `lib/structured-data.ts` with pure builders returning plain objects:
- `organization()` — Organization (name, url, logo, sameAs:[github, npm]).
- `website()` — WebSite (name, url, description) + optional SearchAction → `/docs?q={search_term_string}`.
- `softwareApplication()` — SoftwareApplication (name Hogsend, applicationCategory DeveloperApplication,
  operatingSystem "Node.js", offers price 0 / open source, description, url).
- `faqPage(items: {q,a}[])` — FAQPage with mainEntity Question/Answer.
- `breadcrumb(items: {name,url}[])` — BreadcrumbList.
- `techArticle({title, description, url, datePublished?})` — TechArticle.
Extract the FAQ items to `lib/faq-data.ts` (`export const FAQ_ITEMS`) and import them in BOTH
`components/landing/faq.tsx` AND the home JSON-LD (DRY — one source).

Inject:
- Home (`app/(home)/page.tsx`): `<JsonLd>` with `organization()`, `website()`, `softwareApplication()`,
  and `faqPage(FAQ_ITEMS)`. Add `id="main-content"` to `<main>` for the skip link.
- Docs (`app/docs/[[...slug]]/page.tsx`): `<JsonLd>` with `techArticle(...)` for the page +
  `breadcrumb(...)` built from the slug. Render inside the page.

## A11y + general polish
- `app/layout.tsx`: add a visually-hidden-until-focus "Skip to content" link (`href="#main-content"`)
  as the first body element; ensure `<html lang="en">`.
- Verify heading order (one h1 per page — the hero h1; section headings are h2/h3), focus-visible
  rings on all interactive elements (use grape/raspberry ring), descriptive `aria-label`s on icon-only
  buttons (GitHub, theme toggle, copy), and `alt` text on all images.
- Respect `prefers-reduced-motion` (already global) — keep it.
- FLAGGED visual fixes: the integration logos on the chocolate panel read too faint — bump them
  (e.g. `text-lumen/80` + stronger hover) so they're legible in both themes. Consider a subtle
  second strawberry beat lower in the page only if it improves balance (optional, don't force).
- Keep all exported component names + props stable. `pnpm check-types` MUST pass. Biome-clean
  (2-space, double quotes, semicolons). No console noise.

NORTH STAR: the light neapolitan stays exactly as good as it is now; add a dark mode that feels
designed (espresso + cream + berry + grape), real production SEO + OG image, valid JSON-LD, and a
tighter, more accessible build.
