---
name: brand-studio
description: Generate the full Hogsend brand asset pack — social/OG/banner image templates in every preset, palette colorway and campaign carousel, plus Remotion campaign videos — into the gitignored marketing/out/ folder. Use whenever asked to (re)generate brand templates, ad carousels, campaign stills, brand videos, contact sheets, or "the out folder" of marketing assets.
---

# Hogsend Brand Studio

One pipeline, one output folder. Everything renders into **`marketing/out/`**
(gitignored — outputs are regenerable, never commit them):

```
marketing/out/
  templates/          # image pack (see below) + manifest.json + contact-sheet.png
    clean/            # 15 presets, no headline ("--clean")
    signed/           # 15 presets with brand sign-off ("--signed")
    colorways/        # ember / violet / cyan / acid × 5 hero presets
    examples/         # 6 worked examples with real copy
    campaigns/        # meta / reddit / linkedin × 3 variants × 4-card carousels
    contact-sheets/   # per-platform + campaigns + examples overview PNGs
  videos/<campaign>/  # mp4 + webm + poster per format (landscape/vertical/square) + manifest.json
```

## Image templates (`apps/docs/scripts/render-brand-templates.mjs`)

The renderer boots the docs app on port 3015 (or reuses
`BRAND_TEMPLATE_BASE_URL`), drives `/brand-template/[preset]` pages with
Playwright, and screenshots at exact preset dimensions. Presets, palettes,
examples and campaigns are all defined at the top of the script; the visual
components live in `apps/docs/components/brand/brand-template-canvas.tsx` and
copy in `apps/docs/lib/brand-template-content.ts`.

```bash
# full 92-image pack + manifest + contact sheets (builds docs deps first)
pnpm --filter @hogsend/docs brand:render

# subsets (skip the turbo build if deps are already built):
node apps/docs/scripts/render-brand-templates.mjs --preset og            # one preset
node apps/docs/scripts/render-brand-templates.mjs --kind campaign        # campaigns only
node apps/docs/scripts/render-brand-templates.mjs --desktop              # ALSO mirror to ~/Desktop/"Hogsend Brand Templates"
```

On this machine `next dev` (which the script boots by default) often 404s
under `EMFILE: too many open files` (many concurrent sessions eat the fd
budget). Reliable path: build once, serve prod, point the script at it:

```bash
cd apps/docs && pnpm exec next build
pnpm exec next start --hostname 127.0.0.1 --port 3016 &   # kill when done
BRAND_TEMPLATE_BASE_URL=http://127.0.0.1:3016 node scripts/render-brand-templates.mjs
```

Env knobs: `BRAND_TEMPLATE_OUT_ROOT` (override `marketing/out/templates`),
`BRAND_TEMPLATE_DESKTOP_ROOT`, `BRAND_TEMPLATE_PORT`, `BRAND_TEMPLATE_BASE_URL`.
Playwright + Chromium must be installed (`pnpm exec playwright install chromium` once).

## Campaign videos (`marketing/video/`)

Remotion v4 workspace — read `marketing/video/CONVENTIONS.md` before adding a
video. Each campaign renders three formats (1920×1080, 1080×1920, 1080×1080).

```bash
cd marketing/video
pnpm assets                       # copy screenshots/logos/fonts into public/ (gitignored)
pnpm exec tsx scripts/render-campaign.ts                    # → marketing/out/videos/<campaign>/
pnpm exec tsx scripts/render-campaign.ts --format square    # one format
pnpm exec tsx scripts/render-campaign.ts --output /path     # custom destination
pnpm exec tsx scripts/render-campaign.ts --voice            # requires generated audio, see below
pnpm exec tsx scripts/generate-voice.ts --provider openai   # needs OPENAI_API_KEY
pnpm studio                       # Remotion Studio to preview compositions
```

Shared visual primitives (frames, palettes, motion, content blocks) live in
`packages/brand-media` — reuse them for any new campaign or preset so images
and videos stay on one design system.

## Adding new content (the common ask)

- **New campaign carousel**: add a variant under `CAMPAIGNS` in
  `render-brand-templates.mjs` and its copy in
  `apps/docs/lib/brand-template-content.ts`, then render `--kind campaign`.
- **New image preset**: add to `PRESETS` (+ canvas layout support if the
  aspect is novel), then render `--preset <id>`.
- **New video campaign**: follow the registration contract in
  `marketing/video/CONVENTIONS.md` (own folder + entry), give it a
  `campaign.ts` beat list, render via `render-campaign.ts`.

## Verify (don't skip)

1. `manifest.json` count matches expectation (full run = 92 images, unique paths — the script throws if not).
2. Open `marketing/out/templates/contact-sheet.png` (Read tool) — one glance catches blank/duplicate renders.
3. For videos, check poster PNGs + mp4 byte sizes in the video `manifest.json` (a few MB each; ~0 bytes = failed encode).

## Public-repo hygiene

This repo is public. Never commit rendered outputs (`marketing/out/` is
gitignored), never inline API keys (voice uses `OPENAI_API_KEY` from env), and
keep real customer data out of template copy.
