# Social brand template pack

## Goal

Expand the existing text-free Hogsend brand template renderer into a practical, organized asset pack for social publishing, video, and streaming. Preserve the real `apps/docs` thermal textures, dot grid, noise, and hairline system while adapting composition and safe areas to each platform canvas.

## Output matrix

| Preset | Dimensions | Notes |
| --- | ---: | --- |
| `og` | 1200x630 | Standard Open Graph image |
| `golden` | 1200x742 | Golden-ratio editorial image |
| `social-9x6` | 1080x720 | General 3:2 social post |
| `social-square` | 1080x1080 | Square post |
| `social-portrait` | 1080x1350 | 4:5 feed post |
| `story` | 1080x1920 | Story and Reel canvas |
| `youtube-thumbnail` | 1280x720 | Video thumbnail |
| `youtube-banner` | 2560x1440 | Channel art with a centered 1544x423 safe region scaled from YouTube's official minimum-canvas guidance |
| `linkedin-post` | 1200x627 | LinkedIn landscape post |
| `linkedin-profile-banner` | 1584x396 | Personal profile cover |
| `linkedin-company-banner` | 4200x700 | Company page cover |
| `x-post` | 1600x900 | X landscape post |
| `x-header` | 1500x500 | X profile header |
| `stream-overlay` | 1920x1080 | Transparent edge treatment |
| `stream-screen` | 1920x1080 | Opaque starting, intermission, or ending canvas |

These are export dimensions, not promises about platform upload rules remaining stable. The preset manifest remains the single source of truth so dimensions can be changed without rewriting the renderer.

## Variant system

The pack uses three useful variant classes rather than multiplying every format by every possible treatment:

1. **Clean:** the default red/orange thermal treatment with no words or logos.
2. **Signed:** the default treatment with a small, low-contrast `hogsend.com` mark positioned inside a platform-safe corner.
3. **Colorways:** selected high-use canvases receive ember, violet, cyan, and acid treatments. Colorways remain text-free.

All 15 formats receive clean and signed exports. Colorway exports are limited to `og`, `social-square`, `social-portrait`, `youtube-thumbnail`, and `stream-screen`. This produces 50 opaque or transparent PNGs: 30 core exports plus 20 colorway exports.

The signature is decorative and deliberately subtle. It uses the docs mono typeface where available, stays clear of platform crop and avatar zones, and never appears on clean or colorway exports. The transparent stream overlay remains transparent in both clean and signed versions, with the signature rendered as a small alpha-safe overlay in the signed version.

## Composition and safe areas

The existing `BrandTemplateCanvas` stays responsible for rendering. Presets gain platform metadata for aspect class, safe-area bounds, and signature placement. The renderer scales edge texture and structural rails from normalized geometry, but very wide banners, portrait canvases, and transparent overlays may select tailored composition profiles so the thermal field does not look mechanically stretched.

YouTube channel art protects a centered 1544x423 region, proportionally scaled from YouTube's official 1235x338 safe area at its 2048x1152 minimum canvas to the 2560x1440 recommended canvas. Profile banners protect known avatar-overlap areas by keeping the signature and strongest texture away from the lower-left region. Story/Reel composition keeps its central vertical area quiet for later content. Every format remains usable without adding text.

Colorways recolor the existing thermal luminance and accent layers; they do not introduce unrelated images. The palettes are:

- **ember:** a brighter, higher-heat red, orange, and warm-gold treatment than the restrained default;
- **violet:** magenta, violet, and indigo;
- **cyan:** cyan, electric blue, and teal;
- **acid:** chartreuse, lime, and restrained green.

## Export organization

Repository outputs remain under `apps/docs/public/images/brand/templates/` so the renderer is reproducible. A second export target copies the completed pack to:

`~/Desktop/Hogsend Brand Templates/`

The Desktop folder contains:

- `clean/`
- `signed/`
- `colorways/ember/`
- `colorways/violet/`
- `colorways/cyan/`
- `colorways/acid/`
- `stream/` (the stream presets live here instead of being duplicated under `clean/` and `signed/`)

Filenames include the preset and variant, for example `youtube-thumbnail--clean.png`, `linkedin-profile-banner--signed.png`, and `social-square--cyan.png`. The two stream presets use the same naming convention inside `stream/`.

## Renderer and validation

The Playwright export script accepts a preset, a variant, or the complete matrix. It creates destination directories without deleting unrelated files, waits for fonts and thermal assets, isolates the canvas from application chrome, and captures exact canvas bounds.

Automated checks cover:

- preset dimensions and safe-area geometry;
- valid preset, treatment, and palette combinations;
- signature presence only on signed variants;
- exact PNG dimensions and alpha support for stream overlays;
- transparent stream center with visible edge pixels;
- absence of application UI over every canvas;
- complete Desktop export manifest with unique filenames.

A generated contact sheet provides the final visual review for crop safety, color balance, quiet centers, subtle signatures, and consistency across extreme aspect ratios.

## Boundaries

- No editable text, title placeholders, CMS integration, or browser editor.
- No platform logos or icons.
- No live-site route replacement.
- No promise that third-party platform dimensions will update automatically.
- No Git push unless explicitly requested.
