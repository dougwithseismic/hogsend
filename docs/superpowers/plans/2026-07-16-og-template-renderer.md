# Multi-format Brand Template Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render five reusable, text-free Hogsend brand PNG templates from the real docs thermal and hairline visual system.

**Architecture:** A typed preset manifest drives a focused React canvas and a no-index Next.js preview route. A self-contained Playwright script starts the docs app, captures every preset at its exact viewport, validates PNG dimensions and alpha behaviour, and writes the final assets into `apps/docs/public/images/brand/templates/`.

**Tech Stack:** Next.js 16, React 19, TypeScript, CSS/SVG filters, Playwright, Vitest, Node.js 22, pnpm.

## Global Constraints

- Produce `og` at 1200x630, `golden` at 1200x742, `social-9x6` at 1080x720, `social-square` at 1080x1080, and `stream-overlay` at 1920x1080.
- Keep every canvas text-free: no logo, icon, UI, or placeholder copy.
- Keep at least the middle 55% of landscape canvases and a centered 62% square clear.
- Use the existing thermal WebPs, halftone/dot language, film grain, ink `#050101`, accent `#f64838`, and hairline values.
- The stream overlay must have a fully transparent center and visible alpha-safe edge decoration.
- Do not replace the live landing hero or existing Open Graph route during the spike.
- Add dependencies only with `pnpm add`; do not hand-edit dependency versions.
- Do not push the branch.

---

## File map

- `apps/docs/lib/brand-template-presets.ts` — typed preset keys, dimensions, safe-area and frame geometry.
- `apps/docs/lib/brand-template-presets.test.ts` — exact preset and invariant tests.
- `apps/docs/components/brand/brand-template-canvas.tsx` — decorative canvas using the docs thermal assets and normalized geometry.
- `apps/docs/app/brand-template/[preset]/page.tsx` — no-index preview route and preset validation.
- `apps/docs/scripts/render-brand-templates.mjs` — server lifecycle, Playwright capture, PNG/pixel validation, and file output.
- `apps/docs/public/images/brand/templates/*.png` — five rendered deliverables.
- `apps/docs/package.json` and `pnpm-lock.yaml` — package commands and direct test/render dependencies added through pnpm.

### Task 1: Typed preset manifest

**Files:**
- Create: `apps/docs/lib/brand-template-presets.test.ts`
- Create: `apps/docs/lib/brand-template-presets.ts`
- Modify through pnpm: `apps/docs/package.json`
- Modify through pnpm: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `BrandTemplatePresetKey`, `BrandTemplatePreset`, `BRAND_TEMPLATE_PRESETS`, `isBrandTemplatePresetKey(value)`.
- Consumes: no feature code.

- [ ] **Step 1: Add direct spike dependencies**

Run:

```bash
pnpm --filter @hogsend/docs add -D playwright@latest vitest@latest
```

Expected: `apps/docs/package.json` gains `playwright` and `vitest` in `devDependencies`; the lockfile updates without manually selected versions.

- [ ] **Step 2: Write the failing preset tests**

Create `apps/docs/lib/brand-template-presets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BRAND_TEMPLATE_PRESETS,
  isBrandTemplatePresetKey,
} from "./brand-template-presets";

describe("brand template presets", () => {
  it("defines the five exact output contracts", () => {
    expect(BRAND_TEMPLATE_PRESETS).toEqual({
      og: expect.objectContaining({ width: 1200, height: 630, transparent: false }),
      golden: expect.objectContaining({ width: 1200, height: 742, transparent: false }),
      "social-9x6": expect.objectContaining({ width: 1080, height: 720, transparent: false }),
      "social-square": expect.objectContaining({ width: 1080, height: 1080, transparent: false }),
      "stream-overlay": expect.objectContaining({ width: 1920, height: 1080, transparent: true }),
    });
  });

  it("keeps normalized frame and safe-area values in bounds", () => {
    for (const preset of Object.values(BRAND_TEMPLATE_PRESETS)) {
      expect(preset.frameInset).toBeGreaterThan(0);
      expect(preset.frameInset).toBeLessThan(0.1);
      expect(preset.safeArea).toBeGreaterThanOrEqual(preset.square ? 0.62 : 0.55);
      expect(preset.safeArea).toBeLessThan(0.8);
    }
  });

  it("guards route parameters", () => {
    expect(isBrandTemplatePresetKey("og")).toBe(true);
    expect(isBrandTemplatePresetKey("stream-overlay")).toBe(true);
    expect(isBrandTemplatePresetKey("unknown")).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run:

```bash
pnpm --filter @hogsend/docs exec vitest run lib/brand-template-presets.test.ts
```

Expected: FAIL because `./brand-template-presets` does not exist.

- [ ] **Step 4: Implement the manifest**

Create `apps/docs/lib/brand-template-presets.ts`:

```ts
export const BRAND_TEMPLATE_PRESETS = {
  og: { width: 1200, height: 630, transparent: false, square: false, frameInset: 0.04, safeArea: 0.56 },
  golden: { width: 1200, height: 742, transparent: false, square: false, frameInset: 0.04, safeArea: 0.56 },
  "social-9x6": { width: 1080, height: 720, transparent: false, square: false, frameInset: 0.045, safeArea: 0.56 },
  "social-square": { width: 1080, height: 1080, transparent: false, square: true, frameInset: 0.05, safeArea: 0.62 },
  "stream-overlay": { width: 1920, height: 1080, transparent: true, square: false, frameInset: 0.032, safeArea: 0.58 },
} as const;

export type BrandTemplatePresetKey = keyof typeof BRAND_TEMPLATE_PRESETS;
export type BrandTemplatePreset = (typeof BRAND_TEMPLATE_PRESETS)[BrandTemplatePresetKey];

export function isBrandTemplatePresetKey(value: string): value is BrandTemplatePresetKey {
  return Object.hasOwn(BRAND_TEMPLATE_PRESETS, value);
}
```

- [ ] **Step 5: Run the preset tests**

Run:

```bash
pnpm --filter @hogsend/docs exec vitest run lib/brand-template-presets.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 6: Commit the manifest**

```bash
git add apps/docs/package.json pnpm-lock.yaml apps/docs/lib/brand-template-presets.ts apps/docs/lib/brand-template-presets.test.ts
git commit -m "feat(docs): define brand template presets"
```

### Task 2: Reusable canvas and preview route

**Files:**
- Create: `apps/docs/components/brand/brand-template-canvas.tsx`
- Create: `apps/docs/app/brand-template/[preset]/page.tsx`

**Interfaces:**
- Consumes: `BrandTemplatePresetKey` and `BRAND_TEMPLATE_PRESETS` from Task 1; existing `/images/textures/thermal-1.webp` and `thermal-2.webp`.
- Produces: `BrandTemplateCanvas({ preset })`, `[data-brand-template-canvas]`, and `[data-brand-template-ready]` for the exporter.

- [ ] **Step 1: Extend the failing tests with canvas geometry assertions**

Add to `apps/docs/lib/brand-template-presets.test.ts`:

```ts
it("keeps the stream canvas wider and more transparent than social canvases", () => {
  const stream = BRAND_TEMPLATE_PRESETS["stream-overlay"];
  expect(stream.width / stream.height).toBeCloseTo(16 / 9, 5);
  expect(stream.transparent).toBe(true);
  expect(BRAND_TEMPLATE_PRESETS["social-square"].square).toBe(true);
});
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
pnpm --filter @hogsend/docs exec vitest run lib/brand-template-presets.test.ts
```

Expected: PASS, establishing the geometry contract before the canvas uses it.

- [ ] **Step 3: Implement the decorative canvas**

Create `apps/docs/components/brand/brand-template-canvas.tsx` with these exact responsibilities:

```tsx
import type { CSSProperties } from "react";
import { HalftoneOverlay, ThermalLayer } from "@/components/ds/thermal";
import {
  BRAND_TEMPLATE_PRESETS,
  type BrandTemplatePresetKey,
} from "@/lib/brand-template-presets";

const ACCENT = "#f64838";
const INK = "#050101";
const TEXTURES = ["/images/textures/thermal-1.webp", "/images/textures/thermal-2.webp"] as const;

export function BrandTemplateCanvas({ preset: key }: { preset: BrandTemplatePresetKey }) {
  const preset = BRAND_TEMPLATE_PRESETS[key];
  const insetX = preset.width * preset.frameInset;
  const insetY = preset.height * preset.frameInset;
  const safeWidth = preset.width * preset.safeArea;
  const safeHeight = preset.square ? preset.height * preset.safeArea : preset.height * 0.68;
  const rootStyle: CSSProperties = {
    position: "relative",
    width: preset.width,
    height: preset.height,
    overflow: "hidden",
    backgroundColor: preset.transparent ? "transparent" : INK,
    isolation: "isolate",
  };

  return (
    <div data-brand-template-canvas data-brand-template-ready style={rootStyle}>
      {!preset.transparent && (
        <>
          <div style={{ position: "absolute", inset: 0, maskImage: "linear-gradient(90deg, black, transparent 43%, transparent 57%, black)" }}>
            <ThermalLayer strength={0.3} textures={[...TEXTURES]} />
            <HalftoneOverlay />
          </div>
          <div className="noise" style={{ position: "absolute", inset: 0 }} />
        </>
      )}

      {preset.transparent && <TransparentThermalEdges width={preset.width} height={preset.height} />}

      <div aria-hidden style={{ position: "absolute", inset: 0, backgroundImage: `radial-gradient(${ACCENT}66 1px, transparent 1px)`, backgroundSize: `${Math.max(18, preset.width * 0.018)}px ${Math.max(18, preset.width * 0.018)}px`, maskImage: "linear-gradient(90deg, black, transparent 31%, transparent 69%, black)", opacity: preset.transparent ? 0.32 : 0.42 }} />
      <Frame width={preset.width} height={preset.height} insetX={insetX} insetY={insetY} transparent={preset.transparent} />
      <div aria-hidden data-safe-area style={{ position: "absolute", left: (preset.width - safeWidth) / 2, top: (preset.height - safeHeight) / 2, width: safeWidth, height: safeHeight }} />
    </div>
  );
}
```

In the same file, add the focused helpers:

```tsx
function Frame({ width, height, insetX, insetY, transparent }: {
  width: number;
  height: number;
  insetX: number;
  insetY: number;
  transparent: boolean;
}) {
  const color = transparent ? "rgba(246,72,56,0.35)" : "rgba(255,255,255,0.08)";
  const vertical = [insetX, width - insetX];
  const horizontal = [insetY, height * 0.78, height - insetY];
  return (
    <div aria-hidden style={{ position: "absolute", inset: 0 }}>
      {vertical.map((left) => <span key={`v-${left}`} style={{ position: "absolute", top: 0, bottom: 0, left, width: 1, background: color }} />)}
      {horizontal.map((top) => <span key={`h-${top}`} style={{ position: "absolute", left: 0, right: 0, top, height: 1, background: color }} />)}
    </div>
  );
}

function TransparentThermalEdges({ width, height }: { width: number; height: number }) {
  return (
    <svg aria-hidden width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ position: "absolute", inset: 0 }}>
      <defs>
        <filter id="thermal-to-alpha" colorInterpolationFilters="sRGB">
          <feColorMatrix
            type="matrix"
            values={`0 0 0 0 0.965
                     0 0 0 0 0.282
                     0 0 0 0 0.220
                     0.2126 0.7152 0.0722 0 0`}
          />
        </filter>
        <linearGradient id="left-fade" x1="0" x2="1">
          <stop offset="0" stopColor="white" />
          <stop offset="0.42" stopColor="white" />
          <stop offset="1" stopColor="black" />
        </linearGradient>
        <mask id="left-mask"><rect width={width * 0.5} height={height} fill="url(#left-fade)" /></mask>
        <radialGradient id="right-fade" cx="82%" cy="84%" r="58%">
          <stop offset="0" stopColor="white" />
          <stop offset="1" stopColor="black" />
        </radialGradient>
        <mask id="right-mask"><rect width={width} height={height} fill="url(#right-fade)" /></mask>
      </defs>
      <image href={TEXTURES[0]} x={-width * 0.08} y={-height * 0.06} width={width * 0.62} height={height * 1.12} preserveAspectRatio="xMidYMid slice" filter="url(#thermal-to-alpha)" mask="url(#left-mask)" opacity={0.68} />
      <image href={TEXTURES[1]} x={width * 0.52} y={height * 0.22} width={width * 0.56} height={height * 0.86} preserveAspectRatio="xMidYMid slice" filter="url(#thermal-to-alpha)" mask="url(#right-mask)" opacity={0.72} />
    </svg>
  );
}
```

- [ ] **Step 4: Implement the no-index preview route**

Create `apps/docs/app/brand-template/[preset]/page.tsx`:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BrandTemplateCanvas } from "@/components/brand/brand-template-canvas";
import { isBrandTemplatePresetKey } from "@/lib/brand-template-presets";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function BrandTemplatePreview({ params }: { params: Promise<{ preset: string }> }) {
  const { preset } = await params;
  if (!isBrandTemplatePresetKey(preset)) notFound();

  return (
    <main style={{ margin: 0, width: "fit-content", lineHeight: 0 }}>
      <style>{`html, body { margin: 0 !important; padding: 0 !important; background: transparent !important; overflow: hidden !important; }`}</style>
      <BrandTemplateCanvas preset={preset} />
    </main>
  );
}
```

- [ ] **Step 5: Format and type-check the canvas**

Run:

```bash
pnpm exec biome check apps/docs/components/brand/brand-template-canvas.tsx apps/docs/app/brand-template/'[preset]'/page.tsx apps/docs/lib/brand-template-presets.ts apps/docs/lib/brand-template-presets.test.ts
pnpm turbo run check-types --filter=@hogsend/docs
```

Expected: Biome and all four Turbo tasks pass.

- [ ] **Step 6: Commit the canvas**

```bash
git add apps/docs/components/brand/brand-template-canvas.tsx apps/docs/app/brand-template/'[preset]'/page.tsx apps/docs/lib/brand-template-presets.test.ts
git commit -m "feat(docs): add reusable brand template canvas"
```

### Task 3: Deterministic exporter and rendered assets

**Files:**
- Create: `apps/docs/scripts/render-brand-templates.mjs`
- Modify: `apps/docs/package.json`
- Create: `apps/docs/public/images/brand/templates/og.png`
- Create: `apps/docs/public/images/brand/templates/golden.png`
- Create: `apps/docs/public/images/brand/templates/social-9x6.png`
- Create: `apps/docs/public/images/brand/templates/social-square.png`
- Create: `apps/docs/public/images/brand/templates/stream-overlay.png`

**Interfaces:**
- Consumes: preview URLs `/brand-template/<preset>` and `[data-brand-template-canvas]` from Task 2.
- Produces: `pnpm --filter @hogsend/docs brand:render [preset]` and five validated PNG files.

- [ ] **Step 1: Write the exporter with validation first**

Create `apps/docs/scripts/render-brand-templates.mjs`. Define the same five keys and expected dimensions as immutable runtime data, reject unknown CLI arguments, and implement:

```js
function pngDimensions(buffer) {
  if (buffer.subarray(1, 4).toString("ascii") !== "PNG") throw new Error("not a PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), colorType: buffer[25] };
}

function assertDimensions(name, buffer, expected) {
  const actual = pngDimensions(buffer);
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error(`${name}: expected ${expected.width}x${expected.height}, got ${actual.width}x${actual.height}`);
  }
  if (name === "stream-overlay" && ![4, 6].includes(actual.colorType)) {
    throw new Error(`${name}: PNG does not contain an alpha channel`);
  }
}
```

Add a browser-side `inspectPixels(dataUrl)` helper that draws the screenshot into a canvas and returns center alpha plus the maximum alpha sampled around all four edges. Assert `centerAlpha === 0` and `edgeAlpha > 0` for `stream-overlay`; assert `centerAlpha === 255` for opaque outputs.

- [ ] **Step 2: Complete server and capture lifecycle**

The script must:

1. resolve the repo, docs, and output directories from `import.meta.url`;
2. accept `BRAND_TEMPLATE_BASE_URL` to use an existing server;
3. otherwise spawn `pnpm exec next dev --port ${BRAND_TEMPLATE_PORT ?? 3015}` in `apps/docs`;
4. poll `/brand-template/og` with a 45-second timeout;
5. launch Chromium and set each exact viewport with `deviceScaleFactor: 1`;
6. wait for `document.fonts.ready`, all `img.decode()` calls, and `[data-brand-template-ready]`;
7. capture only `[data-brand-template-canvas]` with `animations: "disabled"` and `omitBackground: true`;
8. validate dimensions and pixel alpha before writing each file;
9. close Chromium and terminate only the server process it spawned in `finally` and signal handlers.

- [ ] **Step 3: Add the package command through pnpm**

Run:

```bash
pnpm --filter @hogsend/docs pkg set 'scripts.brand:render=pnpm --workspace-root turbo run build --filter=@hogsend/docs^... && node scripts/render-brand-templates.mjs'
```

Expected: the command builds only the docs workspace dependencies before starting the renderer, so a fresh install has the `@hogsend/inspector`, `@hogsend/js`, and `@hogsend/react` distributions required by Next.

- [ ] **Step 4: Verify invalid preset handling**

Run:

```bash
pnpm --filter @hogsend/docs brand:render not-a-preset
```

Expected: non-zero exit with `Unknown brand template preset: not-a-preset` and no PNG writes.

- [ ] **Step 5: Render and validate all deliverables**

Run:

```bash
pnpm --filter @hogsend/docs brand:render
file apps/docs/public/images/brand/templates/*.png
```

Expected: exact dimensions for all five files; the script confirms transparent-center/visible-edge pixels for the stream overlay.

- [ ] **Step 6: Perform visual inspection**

Open the five files and confirm:

- center safe areas are visually quiet;
- left and lower-right heat fields fade before the center;
- hairlines remain crisp at every ratio;
- the square composition is balanced rather than a stretched landscape crop;
- the stream file shows only edge decoration over transparency;
- no text, logo, navigation, card, or product UI is present.

- [ ] **Step 7: Run final verification**

Run:

```bash
pnpm --filter @hogsend/docs exec vitest run lib/brand-template-presets.test.ts
pnpm turbo run check-types --filter=@hogsend/docs
pnpm exec biome check apps/docs/components/brand/brand-template-canvas.tsx apps/docs/app/brand-template/'[preset]'/page.tsx apps/docs/lib/brand-template-presets.ts apps/docs/lib/brand-template-presets.test.ts apps/docs/scripts/render-brand-templates.mjs
git diff --check
```

Expected: all tests, type checks, formatting checks, and whitespace checks pass.

- [ ] **Step 8: Commit the exporter and outputs**

```bash
git add apps/docs/package.json pnpm-lock.yaml apps/docs/scripts/render-brand-templates.mjs apps/docs/public/images/brand/templates
git commit -m "feat(docs): render multi-format brand templates"
```
