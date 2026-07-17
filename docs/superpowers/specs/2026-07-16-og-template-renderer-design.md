# Multi-format brand template renderer

## Goal

Create a throwaway spike that renders reusable, text-free Hogsend brand templates from the real `apps/docs` visual system. The outputs must preserve the landing hero's near-black canvas, thermal texture, halftone field, film grain, and structural hairlines while leaving a quiet central safe area for later copy or stream content.

## Outputs

The renderer produces these PNG presets:

| Preset | Dimensions | Background | Intended use |
| --- | ---: | --- | --- |
| `og` | 1200x630 | `#050101` | Standards-safe Open Graph image |
| `golden` | 1200x742 | `#050101` | Golden-ratio editorial image |
| `social-9x6` | 1080x720 | `#050101` | 3:2 social post |
| `social-square` | 1080x1080 | `#050101` | Square social post |
| `stream-overlay` | 1920x1080 | Transparent | Full-HD stream overlay |

The golden-ratio asset remains separate from the standard 1200x630 Open Graph asset so social platforms do not unexpectedly crop the only master.

## Architecture

### Shared canvas

Add a focused `BrandTemplateCanvas` component in `apps/docs`. It accepts a preset name and derives all dimensions and layout values from a single typed preset map. It reuses the existing thermal image files and mirrors the established `ThermalLayer`, `HalftoneOverlay`, `PageFrame`, `.dot-grid`, `.noise`, ink, accent, and hairline values rather than introducing a second visual language.

The canvas contains only decorative layers:

1. the opaque ink surface for non-overlay presets;
2. thermal texture concentrated at the left and lower-right edges;
3. a sparse dot/halftone field that fades before the safe area;
4. proportional vertical frame rails and a small number of horizontal rules;
5. subtle noise on opaque presets;
6. an empty center with no text, logo, icon, UI, or placeholder copy.

The layout scales from normalized percentages rather than fixed desktop pixels. The central safe area occupies at least the middle 55% of landscape canvases and a centered 62% square on the 1:1 canvas.

### Stream alpha treatment

The stream preset has no ink layer. Its center is fully transparent, and only edge decorations remain. Because the existing thermal WebPs have opaque black pixels, the overlay cannot simply place those files over a transparent page. The stream variant uses their luminance as an alpha mask over brand-coloured glow layers, preserving the real thermal shapes without baking a black rectangle into the PNG. Hairlines, dots, and grain use alpha-safe CSS colours.

### Render harness

Add a minimal no-index preview route that renders one preset at a time. A JavaScript export script starts or connects to the docs app, opens each preset at its exact viewport in Chromium, waits for fonts and images, disables animation for deterministic frames, and captures PNGs. The stream capture uses a transparent page plus `omitBackground`.

Generated files live under `apps/docs/public/images/brand/templates/`. The export script is exposed through an `apps/docs` package command and can render either all presets or a named preset.

## Rendering flow

1. The script reads the shared preset manifest.
2. It opens the preview route with the preset key.
3. The route renders `BrandTemplateCanvas` with no dynamic content.
4. The script waits for `document.fonts.ready`, decoded thermal images, and a render-ready marker.
5. Playwright captures the exact canvas bounds with animations disabled.
6. The script validates the PNG header dimensions and confirms that the stream output uses an alpha-capable colour type.
7. A failed render or validation exits non-zero and identifies the preset.

## Error handling

- Unknown preset keys return a not-found response.
- Missing thermal assets prevent the ready marker and fail with a bounded timeout.
- The exporter creates the output directory but never deletes unrelated files.
- A port collision is handled by accepting an existing base URL or choosing the configured render port.
- The spawned docs process is terminated on success, error, or interrupt.

## Verification

- Type-check `@hogsend/docs` through Turbo so workspace dependencies build first.
- Render all five presets.
- Verify every PNG's declared dimensions.
- Verify the stream PNG has transparent pixels at the center and visible non-transparent edge pixels.
- Inspect a contact sheet or the individual outputs for safe-area cleanliness, thermal balance, crisp hairlines, and absence of text/UI.
- Run Biome on changed source files and `git diff --check`.

## Spike boundaries

- No content editor, text API, upload flow, or CMS integration.
- No replacement of the live landing hero or existing Open Graph route during the spike.
- No package extraction until the rendering approach proves useful.
- No Git push; the work remains on the throwaway branch unless explicitly requested.
