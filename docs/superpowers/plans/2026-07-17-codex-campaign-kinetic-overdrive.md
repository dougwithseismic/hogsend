# Codex Campaign Kinetic Overdrive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-cut `codex-campaign` into a deterministic 18-shot, 15-second social ad with an immediate plain-language hook, real Hogsend product screens, aggressive editorial motion, and a readable final CTA.

**Architecture:** A typed shot timeline becomes the source of truth for frame ranges and copy. Focused Remotion components render impact words, prompt/test proof, product crops, and the final stack, while the existing brand frame owns rails and thermal motion. The existing asset preparation command copies canonical Studio screenshots into Remotion's public directory.

**Tech Stack:** React 19, TypeScript, Remotion 4, Vitest, `@hogsend/brand-media`, pnpm.

## Global Constraints

- Keep the composition at exactly 450 frames and 30fps.
- Show the hook on frame 0 and complete “Stop chasing customers by hand” by frame 76.
- Use 16–20 visible cuts, with at least four inside the first three seconds.
- Use real Studio screenshots and intentional crops for landscape, square, and vertical.
- Keep readable content above the lower frame rail and give the CTA equal outer padding.
- Use no lifecycle terminology, CSS keyframes, independent GSAP ticker, or system fallback voice.
- Missing cached OpenAI voice assets must not break a silent render.

---

### Task 1: Make the edit timeline executable and tested

**Files:**
- Create: `marketing/video/src/videos/codex-campaign/edit.ts`
- Create: `marketing/video/src/videos/codex-campaign/edit.test.ts`
- Modify: `marketing/video/src/videos/codex-campaign/campaign.ts`
- Modify: `marketing/video/src/videos/codex-campaign/campaign.test.ts`
- Modify: `marketing/video/src/videos/codex-campaign/scene-state.test.ts`

**Interfaces:**
- Produces: `CampaignShot`, `CAMPAIGN_SHOTS`, `getCampaignShot(frame)`, and updated four-beat campaign copy.
- Consumes: the existing 450-frame campaign contract.

- [ ] **Step 1: Write failing timeline tests**

```ts
it("defines the approved contiguous 18-shot edit", () => {
  expect(CAMPAIGN_SHOTS).toHaveLength(18);
  expect(CAMPAIGN_SHOTS.map(({ from, to }) => [from, to])).toEqual([
    [0, 12], [12, 32], [32, 54], [54, 76], [76, 96], [96, 122],
    [122, 148], [148, 174], [174, 204], [204, 232], [232, 260],
    [260, 290], [290, 314], [314, 338], [338, 364], [364, 392],
    [392, 420], [420, 450],
  ]);
});

it("resolves boundary frames deterministically", () => {
  expect(getCampaignShot(0).id).toBe("stop");
  expect(getCampaignShot(75).id).toBe("by-hand");
  expect(getCampaignShot(449).id).toBe("cta");
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm --dir marketing/video test -- src/videos/codex-campaign/edit.test.ts`

Expected: FAIL because `edit.ts` does not exist.

- [ ] **Step 3: Implement the typed shot timeline**

```ts
export type CampaignShotKind = "impact" | "prompt" | "proof" | "product" | "stack" | "cta";
export type CampaignShot = {
  id: string;
  kind: CampaignShotKind;
  from: number;
  to: number;
  copy: string;
  asset?: "overview" | "journeys" | "contacts" | "campaigns" | "sends";
  focus?: { x: number; y: number; zoom: number };
};

export const CAMPAIGN_SHOTS = [
  { id: "stop", kind: "impact", from: 0, to: 12, copy: "STOP." },
  { id: "chasing", kind: "impact", from: 12, to: 32, copy: "CHASING" },
  { id: "customers", kind: "impact", from: 32, to: 54, copy: "CUSTOMERS" },
  { id: "by-hand", kind: "product", from: 54, to: 76, copy: "BY HAND.", asset: "campaigns", focus: { x: 70, y: 28, zoom: 1.35 } },
  { id: "tell-codex", kind: "impact", from: 76, to: 96, copy: "TELL CODEX" },
  { id: "prompt", kind: "prompt", from: 96, to: 122, copy: "what should happen" },
  { id: "builds", kind: "proof", from: 122, to: 148, copy: "BUILDS." },
  { id: "tests", kind: "proof", from: 148, to: 174, copy: "TESTS." },
  { id: "journeys", kind: "product", from: 174, to: 204, copy: "Journeys", asset: "journeys", focus: { x: 55, y: 46, zoom: 1.18 } },
  { id: "people", kind: "product", from: 204, to: 232, copy: "The right people", asset: "contacts", focus: { x: 28, y: 58, zoom: 1.28 } },
  { id: "message", kind: "product", from: 232, to: 260, copy: "The right message", asset: "campaigns", focus: { x: 72, y: 32, zoom: 1.3 } },
  { id: "ships", kind: "product", from: 260, to: 290, copy: "SHIPS.", asset: "sends", focus: { x: 68, y: 40, zoom: 1.24 } },
  { id: "your-marketing", kind: "product", from: 290, to: 314, copy: "YOUR MARKETING.", asset: "overview", focus: { x: 50, y: 45, zoom: 1.18 } },
  { id: "your-product", kind: "product", from: 314, to: 338, copy: "YOUR PRODUCT.", asset: "journeys", focus: { x: 42, y: 52, zoom: 1.32 } },
  { id: "one-system", kind: "product", from: 338, to: 364, copy: "ONE SYSTEM.", asset: "campaigns", focus: { x: 55, y: 48, zoom: 1.42 } },
  { id: "built-together", kind: "stack", from: 364, to: 392, copy: "BUILT TOGETHER." },
  { id: "promise", kind: "impact", from: 392, to: 420, copy: "Customer marketing, built in." },
  { id: "cta", kind: "cta", from: 420, to: 450, copy: "hogsend.com" },
] as const satisfies readonly CampaignShot[];

export const getCampaignShot = (frame: number): CampaignShot =>
  CAMPAIGN_SHOTS.find(({ from, to }) => frame >= from && frame < to) ?? CAMPAIGN_SHOTS.at(-1)!;
```

Update campaign captions and voice to the approved problem/action/proof/payoff language while keeping the four contiguous beat ranges.

- [ ] **Step 4: Run focused tests**

Run: `pnpm --dir marketing/video test -- src/videos/codex-campaign`

Expected: all campaign tests PASS.

- [ ] **Step 5: Commit**

```bash
git add marketing/video/src/videos/codex-campaign
git commit -m "refactor(video): define kinetic campaign edit"
```

### Task 2: Sync and verify real product assets

**Files:**
- Modify: `marketing/video/scripts/prepare-assets.mjs`
- Create: `marketing/video/scripts/prepare-assets.test.ts`
- Create via asset command: `marketing/video/public/images/studio/*.png`

**Interfaces:**
- Produces: `/images/studio/{overview,journeys,contacts,campaigns,sends}.png` for `staticFile()`.
- Consumes: canonical files under `apps/docs/public/images/studio/`.

- [ ] **Step 1: Write a failing asset-output test**

```ts
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("product screenshot assets", () => {
  it("copies every approved Kinetic Overdrive screen", () => {
    execFileSync(process.execPath, ["scripts/prepare-assets.mjs"], {
      cwd: resolve(import.meta.dirname, ".."),
    });
    for (const file of ["overview", "journeys", "contacts", "campaigns", "sends"]) {
      expect(statSync(resolve(import.meta.dirname, `../public/images/studio/${file}.png`)).size).toBeGreaterThan(10_000);
    }
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --dir marketing/video test -- scripts/prepare-assets.test.ts`

Expected: FAIL because `public/images/studio/overview.png` does not exist.

- [ ] **Step 3: Add the required product asset copy loop**

Add this exact map to `prepare-assets.mjs`, create `public/images/studio/`, and copy every entry without an existence filter so a missing required source fails immediately:

```js
const productScreens = {
  overview: "02-overview-dashboard.png",
  journeys: "08-journeys-overview.png",
  contacts: "10-contacts-directory.png",
  campaigns: "07-campaigns-list.png",
  sends: "04-sends-history.png",
};
for (const [name, file] of Object.entries(productScreens)) {
  copyFileSync(join(repoRoot, "apps/docs/public/images/studio", file), join(out.studio, `${name}.png`));
}
```

Include `5 product screenshots` in the command summary.

- [ ] **Step 4: Generate and verify assets**

Run: `pnpm --dir marketing/video assets && test $(find marketing/video/public/images/studio -name '*.png' | wc -l) -eq 5`

Expected: `assets ready` and exit 0.

- [ ] **Step 5: Commit**

```bash
git add marketing/video/scripts marketing/video/public/images/studio
git commit -m "feat(video): add product shot assets"
```

### Task 3: Build the Kinetic Overdrive shot system

**Files:**
- Create: `marketing/video/src/videos/codex-campaign/shots.tsx`
- Create: `marketing/video/src/videos/codex-campaign/motion.ts`
- Create: `marketing/video/src/videos/codex-campaign/motion.test.ts`
- Modify: `marketing/video/src/videos/codex-campaign/index.tsx`
- Modify: `marketing/video/src/videos/codex-campaign/scene-state.ts`

**Interfaces:**
- Consumes: `CampaignShot`, `CAMPAIGN_SHOTS`, and `getCampaignShot(frame)` from Task 1; product assets from Task 2.
- Produces: `KineticShot`, `snapZoom()`, `impactFlash()`, `directionalOffset()`, and the completed 18-shot composition.

- [ ] **Step 1: Write failing deterministic-motion tests**

```ts
expect(snapZoom(0, 30, 1.35)).toBeCloseTo(1, 4);
expect(snapZoom(30, 30, 1.35)).toBeCloseTo(1.35, 4);
expect(impactFlash(0)).toBe(1);
expect(impactFlash(3)).toBe(0);
expect(directionalOffset(0, 30, -1)).toBeLessThan(0);
expect(directionalOffset(30, 30, -1)).toBe(0);
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --dir marketing/video test -- src/videos/codex-campaign/motion.test.ts`

Expected: FAIL because `motion.ts` does not exist.

- [ ] **Step 3: Implement frame-derived motion helpers**

Use clamped Remotion `interpolate()` and the existing easing helpers so every function is pure and deterministic. `impactFlash()` is one for frames zero and one only; `snapZoom()` and `directionalOffset()` settle by the supplied duration.

- [ ] **Step 4: Implement focused shot components**

`shots.tsx` must export a single `KineticShot({ shot })` dispatcher plus private components for impact copy, prompt proof, build/test proof, product crop, product stack, and CTA. Product crops use `staticFile("images/studio/<asset>.png")`, `objectPosition`, alternating lateral entry direction, a dark gradient for copy contrast, and per-format crop adjustments from `useFormat()`.

Rewrite `index.tsx` to map `CAMPAIGN_SHOTS` to hard-cut `<Sequence>` elements. Keep `BrandFrame`, but drive thermal flashes and camera energy from the active shot/local frame. Remove the persistent caption strip and the four long slideshow scenes.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --dir marketing/video test && pnpm --dir marketing/video check-types`

Expected: all video tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add marketing/video/src/videos/codex-campaign
git commit -m "feat(video): build kinetic campaign recut"
```

### Task 4: Render, inspect, and export all formats

**Files:**
- Modify only if inspection reveals a defect: `marketing/video/src/videos/codex-campaign/*.tsx`
- Generated output: `/Users/godzillaaa/Desktop/Hogsend Brand Videos/codex-campaign/`

**Interfaces:**
- Consumes: the completed composition and existing render/export pipeline.
- Produces: landscape, square, and vertical MP4/WebM/poster artifacts plus manifest.

- [ ] **Step 1: Run repository-level validation**

Run: `pnpm --dir marketing/video test && pnpm --dir marketing/video check-types && pnpm exec biome check marketing/video/src/videos/codex-campaign marketing/video/scripts`

Expected: all commands exit 0.

- [ ] **Step 2: Verify Remotion composition discovery**

Run: `pnpm --dir marketing/video exec remotion compositions src/entries/codex-campaign.ts`

Expected: `codex-campaign-169`, `codex-campaign-11`, and `codex-campaign-916` at 450 frames.

- [ ] **Step 3: Render all formats without voice**

Run: `pnpm --dir marketing/video render:all -- --campaign codex-campaign --desktop`

Expected: successful silent exports beneath `/Users/godzillaaa/Desktop/Hogsend Brand Videos/codex-campaign/`.

- [ ] **Step 4: Inspect contact sheets and final-frame posters**

Extract frames at 0, 54, 96, 174, 260, 338, 392, and 449 for all three formats. Confirm the hook is immediate, product crops show meaningful regions, copy stays above the lower rail, and the CTA padding is equal. Fix defects and repeat validation/render until clean.

- [ ] **Step 5: Commit render-polish changes if any**

```bash
git add marketing/video/src/videos/codex-campaign
git commit -m "fix(video): polish kinetic campaign framing"
```
