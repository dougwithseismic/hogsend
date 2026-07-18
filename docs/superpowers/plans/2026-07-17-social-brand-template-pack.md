# Social Brand Template Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the existing Hogsend brand renderer into a verified 50-PNG social, video, and stream pack and copy it to `~/Desktop/Hogsend Brand Templates/`.

**Architecture:** Keep one typed preset manifest for platform dimensions, safe areas, and composition profiles. Add treatment and palette inputs to the reusable React canvas, pass those values through the no-index preview route, and have the Playwright renderer enumerate the allowed job matrix, validate every PNG, write a manifest/contact sheet, and copy the same buffers into an organized Desktop export.

**Tech Stack:** TypeScript, React, Next.js App Router, Vitest, Node.js `node:test`, Playwright, PNG screenshots.

## Global Constraints

- Produce 15 clean and 15 signed formats plus four colorways for five selected formats: exactly 50 PNGs.
- Use the real `apps/docs` thermal WebPs, dot grid, noise, mono typography, and structural hairlines.
- Keep clean and colorway outputs text-free; signed outputs may contain only a subtle `hogsend.com` mark.
- Preserve a fully transparent center in `stream-overlay`; all other canvases are opaque.
- Protect the centered 1544x423 YouTube channel-art safe region and avoid lower-left profile-avatar zones.
- Repository outputs live below `apps/docs/public/images/brand/templates/`; Desktop outputs live below `~/Desktop/Hogsend Brand Templates/`.
- Do not delete unrelated files from either output location.
- Do not replace live routes, add an editor, or push Git changes.

---

### Task 1: Define the complete preset and variant contracts

**Files:**
- Modify: `apps/docs/lib/brand-template-presets.ts`
- Modify: `apps/docs/lib/brand-template-presets.test.ts`

**Interfaces:**
- Produces: `BrandTemplatePresetKey`, `BrandTemplateTreatment`, `BrandTemplatePaletteKey`, `BRAND_TEMPLATE_PRESETS`, `BRAND_TEMPLATE_PALETTES`, `COLORWAY_PRESETS`, `getBrandTemplateGeometry(key)`, and `getBrandTemplateJobs()`.
- Consumes: no new interfaces.

- [ ] **Step 1: Write failing manifest tests**

Add assertions that the manifest contains these exact dimension pairs:

```ts
const dimensions = {
  og: [1200, 630],
  golden: [1200, 742],
  "social-9x6": [1080, 720],
  "social-square": [1080, 1080],
  "social-portrait": [1080, 1350],
  story: [1080, 1920],
  "youtube-thumbnail": [1280, 720],
  "youtube-banner": [2560, 1440],
  "linkedin-post": [1200, 627],
  "linkedin-profile-banner": [1584, 396],
  "linkedin-company-banner": [4200, 700],
  "x-post": [1600, 900],
  "x-header": [1500, 500],
  "stream-overlay": [1920, 1080],
  "stream-screen": [1920, 1080],
} as const;
```

Test that `getBrandTemplateJobs()` returns 50 unique jobs, all 15 presets have `clean` and `signed` jobs, only `og`, `social-square`, `social-portrait`, `youtube-thumbnail`, and `stream-screen` receive colorway jobs, and `youtube-banner` resolves to a centered 1544x423 safe area.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `pnpm --filter @hogsend/docs exec vitest run lib/brand-template-presets.test.ts`

Expected: FAIL because the additional presets, variant types, and job enumeration do not exist.

- [ ] **Step 3: Implement the typed manifest and job enumerator**

Define the public variant types and palette tokens:

```ts
export type BrandTemplateTreatment = "clean" | "signed" | "colorway";
export type BrandTemplatePaletteKey =
  | "default"
  | "ember"
  | "violet"
  | "cyan"
  | "acid";

export const BRAND_TEMPLATE_PALETTES = {
  default: { accent: "#f64838", hot: "#ff7a45", glow: "#7c140f" },
  ember: { accent: "#ff4d24", hot: "#ffc14d", glow: "#8f1800" },
  violet: { accent: "#c75cff", hot: "#ff4fd8", glow: "#3a1b91" },
  cyan: { accent: "#30d9ff", hot: "#73fff2", glow: "#075c91" },
  acid: { accent: "#b8ff38", hot: "#efff73", glow: "#357800" },
} as const;
```

Give every preset exact `width`, `height`, `transparent`, `composition`, and normalized safe bounds. For `youtube-banner`, store `{ x: 508, y: 508.5, width: 1544, height: 423 }` as explicit pixel bounds. Export `COLORWAY_PRESETS` for the five approved keys. `getBrandTemplateJobs()` must emit clean and signed jobs for every preset plus four non-default colorways for every key in `COLORWAY_PRESETS`.

- [ ] **Step 4: Run the preset tests**

Run: `pnpm --filter @hogsend/docs exec vitest run lib/brand-template-presets.test.ts`

Expected: PASS with 15 exact presets, five palettes, 50 unique jobs, and the channel-art safe region.

- [ ] **Step 5: Commit the preset contract**

```bash
git add apps/docs/lib/brand-template-presets.ts apps/docs/lib/brand-template-presets.test.ts
git commit -m "feat(docs): expand brand template presets"
```

---

### Task 2: Add adaptive compositions, colorways, and signatures

**Files:**
- Modify: `apps/docs/components/brand/brand-template-canvas.tsx`
- Modify: `apps/docs/components/brand/brand-template-canvas.test.tsx`
- Modify: `apps/docs/app/brand-template/[preset]/page.tsx`

**Interfaces:**
- Consumes: `BrandTemplatePresetKey`, `BrandTemplateTreatment`, `BrandTemplatePaletteKey`, palette tokens, and safe geometry from Task 1.
- Produces: `BrandTemplateCanvas({ preset, treatment, palette })` and a preview route accepting `?treatment=<value>&palette=<value>`.

- [ ] **Step 1: Write failing canvas tests**

Cover all behavior through static markup:

```tsx
const signed = renderToStaticMarkup(
  <BrandTemplateCanvas preset="linkedin-profile-banner" treatment="signed" palette="default" />,
);
expect(signed).toContain("hogsend.com");
expect(signed).toContain('data-composition="wide"');

const violet = renderToStaticMarkup(
  <BrandTemplateCanvas preset="social-square" treatment="colorway" palette="violet" />,
);
expect(violet).toContain("#c75cff");
expect(violet).not.toContain("hogsend.com");

const clean = renderToStaticMarkup(
  <BrandTemplateCanvas preset="story" treatment="clean" palette="default" />,
);
expect(clean).not.toContain("hogsend.com");
```

Retain the transparent stream assertions and require unique SVG filter IDs derived from the preset and palette.

- [ ] **Step 2: Run the focused canvas test and confirm it fails**

Run: `pnpm --filter @hogsend/docs exec vitest run components/brand/brand-template-canvas.test.tsx`

Expected: FAIL because the canvas does not yet accept treatment or palette inputs.

- [ ] **Step 3: Implement adaptive rendering**

Change the canvas signature to:

```ts
type BrandTemplateCanvasProps = {
  preset: BrandTemplatePresetKey;
  treatment?: BrandTemplateTreatment;
  palette?: BrandTemplatePaletteKey;
};
```

Use palette `accent`, `hot`, and `glow` values for dots, glows, rails, and the transparent SVG color matrix. Select landscape, portrait, wide, square, and overlay placement parameters from a small `COMPOSITIONS` lookup instead of stretching one layout. Render the signature only when `treatment === "signed"`, positioned relative to the preset safe bounds:

```tsx
{treatment === "signed" && (
  <span
    data-brand-signature="true"
    style={{
      position: "absolute",
      right: preset.width - safeBounds.x - safeBounds.width + signatureInset,
      bottom: preset.height - safeBounds.y - safeBounds.height + signatureInset,
      color: `${paletteTokens.hot}99`,
      fontFamily: "var(--font-geist-mono), monospace",
      fontSize: Math.max(11, Math.min(18, preset.height * 0.025)),
      letterSpacing: "0.08em",
      lineHeight: 1,
    }}
  >
    hogsend.com
  </span>
)}
```

For transparent output, keep the center alpha at zero and use palette colors only on edge decorations.

- [ ] **Step 4: Parse preview query parameters safely**

Update the route to accept `searchParams`, default to `clean` and `default`, call the exported treatment/palette guards, and return `notFound()` for an invalid combination. Pass the validated values to `BrandTemplateCanvas`.

- [ ] **Step 5: Run both React and preset tests**

Run: `pnpm --filter @hogsend/docs exec vitest run components/brand/brand-template-canvas.test.tsx lib/brand-template-presets.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the canvas variants**

```bash
git add apps/docs/components/brand/brand-template-canvas.tsx apps/docs/components/brand/brand-template-canvas.test.tsx apps/docs/app/brand-template/'[preset]'/page.tsx
git commit -m "feat(docs): add brand template treatments"
```

---

### Task 3: Enumerate, validate, and export the complete pack

**Files:**
- Modify: `apps/docs/scripts/render-brand-templates.mjs`
- Modify: `apps/docs/scripts/render-brand-templates.node-test.mjs`
- Modify: `apps/docs/package.json`

**Interfaces:**
- Consumes: the exact preset and palette values from Tasks 1 and 2; because the renderer is plain ESM, mirror the serializable dimensions/job matrix and protect it with exact-count tests.
- Produces: `parseRenderArguments(argv)`, `outputRelativePath(job)`, `createRenderJobs()`, a 50-entry `manifest.json`, `contact-sheet.png`, repository PNGs, and the Desktop copy.

- [ ] **Step 1: Write failing Node renderer tests**

Add tests for these contracts:

```js
assert.equal(createRenderJobs().length, 50);
assert.equal(new Set(createRenderJobs().map(jobKey)).size, 50);
assert.equal(
  outputRelativePath({ preset: "youtube-thumbnail", treatment: "signed", palette: "default" }),
  "signed/youtube-thumbnail--signed.png",
);
assert.equal(
  outputRelativePath({ preset: "social-square", treatment: "colorway", palette: "cyan" }),
  "colorways/cyan/social-square--cyan.png",
);
assert.equal(
  outputRelativePath({ preset: "stream-overlay", treatment: "clean", palette: "default" }),
  "stream/stream-overlay--clean.png",
);
```

Test argument filters for `--preset`, `--treatment`, `--palette`, and `--desktop`, rejecting unknown values and rejecting a colorway request for a non-colorway preset.

- [ ] **Step 2: Run Node tests and confirm they fail**

Run: `node --test apps/docs/scripts/render-brand-templates.node-test.mjs`

Expected: FAIL because the render-job and output-path APIs do not exist.

- [ ] **Step 3: Implement render jobs and destination mapping**

Represent each job as:

```js
{
  preset: "social-square",
  treatment: "colorway",
  palette: "cyan",
  width: 1080,
  height: 1080,
}
```

Open previews with encoded query parameters. Write each screenshot buffer to both the repository path and, when `--desktop` is enabled, `join(homedir(), "Desktop", "Hogsend Brand Templates", outputRelativePath(job))`. Create parent directories recursively and never remove the destination root.

- [ ] **Step 4: Add per-image validation and the export manifest**

Validate exact dimensions for every job. Treat only `stream-overlay` as alpha-required. Verify the stream center and edge alpha contract for both clean and signed overlay jobs. Write `manifest.json` containing each relative filename, preset, treatment, palette, width, height, and transparency flag. Assert that 50 unique PNG paths were written before reporting success.

- [ ] **Step 5: Generate a deterministic contact sheet**

After rendering, create a new Playwright page with a 1600px-wide dark grid of thumbnail cards sourced from the rendered PNG buffers. Each card shows the filename below the image. Capture the full page to `contact-sheet.png` in both the repository output root and Desktop root. The sheet is a review artifact and is not counted among the 50 templates.

- [ ] **Step 6: Update the package command**

Keep the existing workspace dependency build and change the renderer invocation so:

```json
"brand:render": "pnpm --workspace-root turbo run build --filter=@hogsend/docs^... && node scripts/render-brand-templates.mjs"
```

continues to render the repository pack, while `pnpm brand:render -- --desktop` also copies it to Desktop.

- [ ] **Step 7: Run Node tests**

Run: `node --test apps/docs/scripts/render-brand-templates.node-test.mjs`

Expected: PASS with argument, job-count, naming, PNG metadata, and alpha validation tests.

- [ ] **Step 8: Commit the exporter**

```bash
git add apps/docs/scripts/render-brand-templates.mjs apps/docs/scripts/render-brand-templates.node-test.mjs apps/docs/package.json
git commit -m "feat(docs): export social brand template pack"
```

---

### Task 4: Render and verify the deliverables

**Files:**
- Generate: `apps/docs/public/images/brand/templates/**/*.png`
- Generate: `apps/docs/public/images/brand/templates/manifest.json`
- Generate: `apps/docs/public/images/brand/templates/contact-sheet.png`
- Generate outside Git: `~/Desktop/Hogsend Brand Templates/**`

**Interfaces:**
- Consumes: the complete renderer from Task 3.
- Produces: the verified repository and Desktop asset packs.

- [ ] **Step 1: Run all focused unit tests**

Run:

```bash
pnpm --filter @hogsend/docs exec vitest run components/brand/brand-template-canvas.test.tsx lib/brand-template-presets.test.ts
node --test apps/docs/scripts/render-brand-templates.node-test.mjs
```

Expected: all tests PASS.

- [ ] **Step 2: Render the complete pack to both destinations**

Run: `pnpm --filter @hogsend/docs brand:render -- --desktop`

Expected: 50 `rendered` lines followed by manifest and contact-sheet paths; command exits zero.

- [ ] **Step 3: Verify file counts and dimensions**

Run a read-only Node check over both manifests. Assert 50 entries, 50 unique filenames, every file exists in both destinations, every PNG IHDR matches the manifest, and only the two `stream-overlay` variants require alpha-capable PNG color types.

- [ ] **Step 4: Inspect the contact sheet and representative full-size files**

Inspect `contact-sheet.png`, then view at original resolution: YouTube banner clean, LinkedIn personal banner signed, social portrait violet, square cyan, YouTube thumbnail acid, stream overlay clean composited over a dark test background, and stream screen ember. Confirm quiet safe areas, no stretched thermal artifacts, subtle signature, correct color separation, and no app chrome.

- [ ] **Step 5: Run final source verification**

Run:

```bash
pnpm turbo run check-types --filter=@hogsend/docs
pnpm --filter @hogsend/docs exec biome check \
  apps/docs/lib/brand-template-presets.ts \
  apps/docs/lib/brand-template-presets.test.ts \
  apps/docs/components/brand/brand-template-canvas.tsx \
  apps/docs/components/brand/brand-template-canvas.test.tsx \
  apps/docs/app/brand-template/'[preset]'/page.tsx \
  apps/docs/scripts/render-brand-templates.mjs \
  apps/docs/scripts/render-brand-templates.node-test.mjs
git diff --check
```

Expected: typecheck succeeds, Biome reports no errors, and `git diff --check` is silent.

- [ ] **Step 6: Commit generated repository assets**

```bash
git add apps/docs/public/images/brand/templates
git commit -m "chore(docs): render social brand template assets"
```

- [ ] **Step 7: Confirm handoff state**

Run: `git status --short --branch`

Expected: clean `codex/og-template-spike` worktree; no push performed; Desktop pack exists at `~/Desktop/Hogsend Brand Templates/`.
