# Uniform Frames and Content Carousels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rerender the 50 Hogsend blank templates with equal four-sided frame padding and expand the deterministic pack with 6 design-system examples and 36 article-grounded ad-carousel cards.

**Architecture:** Keep decorative rendering, content data, content layout, and export orchestration as separate units. The preset module owns dimensions and frame geometry; a new content module owns all stable copy and job identifiers; a focused React content component renders those models inside existing safe areas; the Playwright exporter enumerates all 92 jobs and writes platform-specific contact sheets and byte-identical Desktop copies.

**Tech Stack:** TypeScript, React, Next.js App Router, Vitest, Node.js `node:test`, Playwright, PNG screenshots.

## Global Constraints

- Final manifest: exactly 92 unique PNGs — 50 templates, 6 examples, and 36 campaign cards.
- Frame inset: `clamp(round(min(width, height) * 0.045), 24, 64)` and identical on all four outer edges.
- Carousel cards: 1080×1080, four ordered cards for each of three variants on Meta, Reddit, and LinkedIn.
- Use exact article-grounded copy from `docs/superpowers/specs/2026-07-17-uniform-frames-content-and-ad-carousels-design.md`.
- Use Inter/`var(--font-sans)` for headlines and Geist Mono/`var(--font-mono)` for labels, commands, and sequence metadata.
- Every content job includes `hogsend.com`; blank clean/colorway jobs remain text-free.
- Every campaign PNG must remain under 10 MB and fit content entirely inside its safe area.
- Repository and `~/Desktop/Hogsend Brand Templates/` outputs must match byte-for-byte.
- Do not upload ads, spend money, merge, or push.

---

### Task 1: Enforce equal four-sided frame geometry

**Files:**
- Modify: `apps/docs/lib/brand-template-presets.ts`
- Modify: `apps/docs/lib/brand-template-presets.test.ts`

**Interfaces:**
- Produces: `getUniformFrameInset(width, height): number` and equal `frameInsetX`/`frameInsetY` from `getBrandTemplateGeometry(key)`.
- Consumes: existing preset width, height, and safe-area definitions.

- [ ] **Step 1: Write failing geometry tests**

Add:

```ts
it("uses one clamped inset on all four frame edges", () => {
  expect(getUniformFrameInset(1200, 630)).toBe(28);
  expect(getUniformFrameInset(1080, 1080)).toBe(49);
  expect(getUniformFrameInset(1584, 396)).toBe(24);
  expect(getUniformFrameInset(2560, 1440)).toBe(64);

  for (const key of Object.keys(BRAND_TEMPLATE_PRESETS) as BrandTemplatePresetKey[]) {
    const geometry = getBrandTemplateGeometry(key);
    expect(geometry.frameInsetX).toBe(geometry.frameInsetY);
    expect(geometry.frameInsetX).toBeGreaterThanOrEqual(24);
    expect(geometry.frameInsetX).toBeLessThanOrEqual(64);
  }
});
```

- [ ] **Step 2: Run the preset suite and confirm red**

Run: `pnpm --filter @hogsend/docs exec vitest run lib/brand-template-presets.test.ts`

Expected: FAIL because `getUniformFrameInset` does not exist and current X/Y insets differ.

- [ ] **Step 3: Implement the shared inset**

Remove per-preset `frameInset` configuration and implement:

```ts
export function getUniformFrameInset(width: number, height: number) {
  return Math.min(64, Math.max(24, Math.round(Math.min(width, height) * 0.045)));
}
```

In `getBrandTemplateGeometry`, assign the same result to `frameInsetX` and `frameInsetY`. Do not change safe-area calculations.

- [ ] **Step 4: Run the preset suite and commit**

Run: `pnpm --filter @hogsend/docs exec vitest run lib/brand-template-presets.test.ts`

Expected: PASS.

```bash
git add apps/docs/lib/brand-template-presets.ts apps/docs/lib/brand-template-presets.test.ts
git commit -m "fix(docs): unify brand template frame insets"
```

---

### Task 2: Define the complete content and campaign data model

**Files:**
- Create: `apps/docs/lib/brand-template-content.ts`
- Create: `apps/docs/lib/brand-template-content.test.ts`

**Interfaces:**
- Produces: `BrandTemplateContent`, `BrandTextExample`, `BrandCarouselPlatform`, `BrandCarouselVariant`, `BRAND_TEXT_EXAMPLES`, `BRAND_CAROUSEL_CAMPAIGNS`, `getBrandContentJobs()`, `resolveBrandTextExample(id)`, and `resolveBrandCarouselCard(platform, variant, card)`.
- Consumes: `BrandTemplatePaletteKey` and `BrandTemplatePresetKey` from Task 1.

- [ ] **Step 1: Write failing data-contract tests**

Test exact identifiers and counts:

```ts
expect(Object.keys(BRAND_TEXT_EXAMPLES)).toEqual([
  "og-product-logic",
  "youtube-lifecycle-automation",
  "linkedin-measure-keep-grow",
  "square-typed-tested-shipped",
  "portrait-signup-to-retention",
  "stream-building-live",
]);

expect(Object.keys(BRAND_CAROUSEL_CAMPAIGNS)).toEqual([
  "meta",
  "reddit",
  "linkedin",
]);

expect(Object.keys(BRAND_CAROUSEL_CAMPAIGNS.meta)).toEqual([
  "leaking-bucket",
  "after-signup",
  "launch-spike",
]);
expect(Object.keys(BRAND_CAROUSEL_CAMPAIGNS.reddit)).toEqual([
  "one-person-silo",
  "silent-drift",
  "clock-speed",
]);
expect(Object.keys(BRAND_CAROUSEL_CAMPAIGNS.linkedin)).toEqual([
  "shipping-not-launching",
  "owner-bottleneck",
  "launch-pipeline",
]);

const jobs = getBrandContentJobs();
expect(jobs.filter((job) => job.kind === "example")).toHaveLength(6);
expect(jobs.filter((job) => job.kind === "campaign")).toHaveLength(36);
expect(new Set(jobs.map((job) => job.id)).size).toBe(42);
```

For every campaign variant, assert exactly four cards with roles `problem`, `action`, `hogsend`, and `get-started`, sequences `01 / 04` through `04 / 04`, a non-empty headline/body, and a command on card four.

- [ ] **Step 2: Run the content suite and confirm red**

Run: `pnpm --filter @hogsend/docs exec vitest run lib/brand-template-content.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Define the types and six examples**

Implement:

```ts
export type BrandContentLayout = "editorial" | "code" | "steps" | "cta";
export type BrandCarouselPlatform = "meta" | "reddit" | "linkedin";
export type BrandCarouselCardRole = "problem" | "action" | "hogsend" | "get-started";

export type BrandTemplateContent = {
  eyebrow: string;
  headline: string;
  body: string;
  layout: BrandContentLayout;
  command?: string;
  steps?: readonly string[];
  sequence?: string;
  signature: "hogsend.com";
};
```

Define all six example records with the exact IDs, dimensions/presets, headlines, commands, and layouts in the approved spec. Use palettes `default`, `ember`, `violet`, `cyan`, `acid`, and `default` respectively.

- [ ] **Step 4: Define all nine campaigns with exact four-card copy**

Create the nested campaign object with these exact variant/palette mappings:

```ts
meta: {
  "leaking-bucket": { palette: "ember", headlines: [
    "Buying more signups before users stick?",
    "Measure → Keep → Grow.",
    "Turn behavior into action.",
    "Ship the journey. Learn faster.",
  ]},
  "after-signup": { palette: "violet", headlines: [
    "What happens after signup?",
    "Define activation first.",
    "React while intent is fresh.",
    "Start with one activation journey.",
  ]},
  "launch-spike": { palette: "cyan", headlines: [
    "Another launch spike. Another slow decay?",
    "Keep before you grow.",
    "Build retention into the product loop.",
    "Turn the next signup into a retained user.",
  ]},
},
reddit: {
  "one-person-silo": { palette: "ember", headlines: [
    "Does your lifecycle stack live in one person’s browser tabs?",
    "Move journeys into the repo.",
    "Give the code a runtime.",
    "Read the code. Ship one journey.",
  ]},
  "silent-drift": { palette: "violet", headlines: [
    "Ever had a journey quietly stop firing?",
    "Share one event vocabulary.",
    "Let the compiler find drift.",
    "Replace data archaeology with a PR.",
  ]},
  "clock-speed": { palette: "acid", headlines: [
    "Your product ships daily. Why does lifecycle still move at click-speed?",
    "Let agents work on lifecycle too.",
    "Keep authorship in the repo.",
    "Bring lifecycle up to product speed.",
  ]},
},
linkedin: {
  "shipping-not-launching": { palette: "ember", headlines: [
    "Your team merged the feature. Did the right users find out?",
    "Launch inside-out.",
    "Make relevance executable.",
    "Make ‘users find out’ part of done.",
  ]},
  "owner-bottleneck": { palette: "violet", headlines: [
    "Can anyone besides one operator change your lifecycle layer?",
    "Make lifecycle shared product logic.",
    "Separate authorship from visibility.",
    "Remove the bottleneck without losing control.",
  ]},
  "launch-pipeline": { palette: "cyan", headlines: [
    "A launch is a pipeline, not a post.",
    "Build the queue before launch day.",
    "Connect product events to the pipeline.",
    "Engineer repeatable distribution.",
  ]},
},
```

Populate every body from the exact approved spec. Assign layouts `editorial`, `steps`, `code`, `cta`; roles in the required order; and `pnpm dlx create-hogsend@latest` to every fourth card.

- [ ] **Step 5: Implement resolvers and job enumeration**

Examples retain their declared preset. Campaigns always use `social-square`. Invalid identifiers or cards outside 1–4 return `undefined`. `getBrandContentJobs()` emits 6 example jobs followed by 36 campaign jobs with stable IDs such as `campaign:reddit:silent-drift:2`.

- [ ] **Step 6: Run tests and commit**

Run: `pnpm --filter @hogsend/docs exec vitest run lib/brand-template-content.test.ts lib/brand-template-presets.test.ts`

Expected: PASS.

```bash
git add apps/docs/lib/brand-template-content.ts apps/docs/lib/brand-template-content.test.ts
git commit -m "feat(docs): define brand campaign content"
```

---

### Task 3: Render design-system content inside safe areas

**Files:**
- Create: `apps/docs/components/brand/brand-template-content.tsx`
- Create: `apps/docs/components/brand/brand-template-content.test.tsx`
- Modify: `apps/docs/components/brand/brand-template-canvas.tsx`
- Modify: `apps/docs/components/brand/brand-template-canvas.test.tsx`

**Interfaces:**
- Consumes: `BrandTemplateContent`, preset geometry, and palette tokens.
- Produces: `BrandTemplateContentLayer({ preset, palette, content })`; `BrandTemplateCanvas` accepts `children?: ReactNode`.

- [ ] **Step 1: Write failing markup tests**

Verify a Reddit technical card renders sequence, mono command/code treatment, headline, body, and signature inside `data-brand-content`; verify a Meta problem card does not render a command; verify a CTA does. Assert fonts use `var(--font-sans)` and `var(--font-mono)`, and long headlines receive `data-copy-density="compact"`.

Add a canvas regression assertion that clean canvases remain text-free when no child is supplied and that supplied content appears after decorative layers.

- [ ] **Step 2: Run component tests and confirm red**

Run: `pnpm --filter @hogsend/docs exec vitest run components/brand/brand-template-content.test.tsx components/brand/brand-template-canvas.test.tsx`

Expected: FAIL because the content component and children contract do not exist.

- [ ] **Step 3: Add the children seam**

Update canvas props:

```ts
export type BrandTemplateCanvasProps = {
  preset: BrandTemplatePresetKey;
  treatment?: BrandTemplateTreatment;
  palette?: BrandTemplatePaletteKey;
  children?: ReactNode;
};
```

Render `children` last. Preserve blank-template behavior and transparent overlays.

- [ ] **Step 4: Implement the content layer**

Position a flex column at `safeX`, `safeY`, `safeWidth`, and `safeHeight`. Use a compact headline size when `headline.length > 52`; otherwise use the regular size. Scale headline, body, eyebrow, panel, and footer sizes from the shorter canvas edge with explicit min/max clamps. Render:

```tsx
<section data-brand-content data-copy-density={density} style={safeAreaStyle}>
  <header>
    <span>{content.eyebrow}</span>
    {content.sequence && <span>{content.sequence}</span>}
  </header>
  <div>
    <h1>{content.headline}</h1>
    <p>{content.body}</p>
    {content.steps && <ol>{content.steps.map(...)}</ol>}
    {content.command && <div data-brand-command>$ {content.command}</div>}
  </div>
  <footer><span>hogsend.com</span><span>→</span></footer>
</section>
```

Use palette accent/hot/glow values for the eyebrow, command prompt, and fine borders. Keep body width under 92% of the safe area and line height at least 1.25.

- [ ] **Step 5: Run component suites and commit**

Run: `pnpm --filter @hogsend/docs exec vitest run components/brand/brand-template-content.test.tsx components/brand/brand-template-canvas.test.tsx lib/brand-template-content.test.ts`

Expected: PASS.

```bash
git add apps/docs/components/brand/brand-template-content.tsx apps/docs/components/brand/brand-template-content.test.tsx apps/docs/components/brand/brand-template-canvas.tsx apps/docs/components/brand/brand-template-canvas.test.tsx
git commit -m "feat(docs): render brand template content"
```

---

### Task 4: Extend the preview route and 92-job exporter

**Files:**
- Modify: `apps/docs/app/brand-template/[preset]/page.tsx`
- Modify: `apps/docs/scripts/render-brand-templates.mjs`
- Modify: `apps/docs/scripts/render-brand-templates.node-test.mjs`

**Interfaces:**
- Consumes: resolvers and content component from Tasks 2–3.
- Produces: preview URLs using `?example=<id>` or `?platform=<platform>&variant=<variant>&card=<1-4>`; renderer job kinds `template`, `example`, and `campaign`; platform contact sheets.

- [ ] **Step 1: Write failing renderer tests**

Update tests to assert:

```js
const jobs = createRenderJobs();
assert.equal(jobs.length, 92);
assert.equal(jobs.filter((job) => job.kind === "template").length, 50);
assert.equal(jobs.filter((job) => job.kind === "example").length, 6);
assert.equal(jobs.filter((job) => job.kind === "campaign").length, 36);
assert.equal(new Set(jobs.map(jobKey)).size, 92);

assert.equal(
  outputRelativePath({ kind: "example", example: "og-product-logic" }),
  "examples/og-product-logic.png",
);
assert.equal(
  outputRelativePath({
    kind: "campaign",
    platform: "reddit",
    variant: "silent-drift",
    card: 2,
    role: "action",
  }),
  "campaigns/reddit/silent-drift/02-action.png",
);
```

Test `--kind`, `--example`, `--platform`, `--variant`, and `--card` filters plus existing template filters. Unknown combinations must fail with `No render jobs match`.

- [ ] **Step 2: Run Node tests and confirm red**

Run: `node --test apps/docs/scripts/render-brand-templates.node-test.mjs`

Expected: FAIL because only 50 template jobs exist.

- [ ] **Step 3: Resolve content in the preview route**

If `example` is present, resolve it and ensure its preset matches the route. If campaign query keys are present, resolve the exact card and require `social-square`. Invalid/mixed content queries call `notFound()`. Render:

```tsx
<BrandTemplateCanvas preset={preset} treatment="clean" palette={resolved.palette}>
  <BrandTemplateContentLayer
    preset={preset}
    palette={resolved.palette}
    content={resolved.content}
  />
</BrandTemplateCanvas>
```

Keep the existing blank-template query path unchanged.

- [ ] **Step 4: Extend renderer jobs and paths**

Mirror the six example identifiers and nine campaign variant/palette keys in plain ESM. Add `kind` to every existing template job. Build content preview URLs from stable query parameters. Output examples and campaign cards to the exact spec paths.

- [ ] **Step 5: Add browser overflow and size validation**

For content jobs, evaluate the content root and fail if `scrollWidth > clientWidth`, `scrollHeight > clientHeight`, or any descendant rectangle exceeds the content safe-area rectangle by more than one pixel. Fail campaign jobs above `10 * 1024 * 1024` bytes.

- [ ] **Step 6: Generate grouped contact sheets**

Generalize contact-sheet creation to accept an output relative path. Generate:

```text
contact-sheet.png
contact-sheets/examples.png
contact-sheets/meta.png
contact-sheets/reddit.png
contact-sheets/linkedin.png
contact-sheets/campaigns.png
```

Use the sequential lightweight thumbnails already produced during rendering.

- [ ] **Step 7: Update manifest entries and run tests**

Manifest entries include `kind`, output path, dimensions, palette, and content identifiers. Run:

```bash
node --test apps/docs/scripts/render-brand-templates.node-test.mjs
pnpm --filter @hogsend/docs exec vitest run \
  lib/brand-template-content.test.ts \
  components/brand/brand-template-content.test.tsx \
  components/brand/brand-template-canvas.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit exporter changes**

```bash
git add apps/docs/app/brand-template/'[preset]'/page.tsx apps/docs/scripts/render-brand-templates.mjs apps/docs/scripts/render-brand-templates.node-test.mjs
git commit -m "feat(docs): export brand content campaigns"
```

---

### Task 5: Render, inspect, verify, and commit all outputs

**Files:**
- Regenerate: `apps/docs/public/images/brand/templates/**/*.png`
- Regenerate: `apps/docs/public/images/brand/templates/manifest.json`
- Export outside Git: `~/Desktop/Hogsend Brand Templates/**`

**Interfaces:**
- Consumes: complete renderer.
- Produces: 92 verified images and six contact sheets in both destinations.

- [ ] **Step 1: Run focused tests and typecheck**

Run:

```bash
pnpm --filter @hogsend/docs exec vitest run \
  lib/brand-template-presets.test.ts \
  lib/brand-template-content.test.ts \
  components/brand/brand-template-canvas.test.tsx \
  components/brand/brand-template-content.test.tsx
node --test apps/docs/scripts/render-brand-templates.node-test.mjs
pnpm turbo run check-types --filter=@hogsend/docs
```

Expected: all tests and typecheck PASS.

- [ ] **Step 2: Render the complete repository and Desktop pack**

Run: `pnpm --filter @hogsend/docs brand:render -- --desktop`

Expected: 92 rendered lines, manifest count 92, six contact sheets, zero overflow/dimension/alpha/file-size failures.

- [ ] **Step 3: Audit both destinations**

Read both manifests and assert byte equality; 92 entries; 50/6/36 kind counts; unique paths; all files exist in both destinations; dimensions match IHDR; only the two stream overlay templates require alpha; all campaign cards are below 10 MB.

- [ ] **Step 4: Inspect every contact sheet**

Inspect combined, examples, Meta, Reddit, LinkedIn, and campaign sheets. Then inspect at original resolution at least one long-copy card per platform, all six examples, one CTA, one code layout, one portrait, one banner, and the transparent stream overlay composited over a dark background. Confirm equal outer padding, hierarchy, no clipping, sequence order, correct palettes, and readable commands.

- [ ] **Step 5: Run source hygiene checks**

Run Biome on every changed TS/TSX/MJS file, `git diff --check`, and `git status --short`.

- [ ] **Step 6: Commit generated assets**

```bash
git add apps/docs/public/images/brand/templates
git commit -m "chore(docs): render brand campaign variants"
```

- [ ] **Step 7: Fresh completion audit**

Rerun focused tests, Node tests, typecheck, manifest parity, and clean-worktree checks. Preserve `codex/og-template-spike`; do not push or merge.
