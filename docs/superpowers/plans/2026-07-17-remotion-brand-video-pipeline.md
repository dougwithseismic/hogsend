# Remotion Brand Video Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add a local Remotion Studio and deterministic render pipeline that turns Hogsend's existing brand system into high-fidelity 15-second vertical, square, and landscape campaign videos with an immediate hook, kinetic captions, optional cached OpenAI voice, and Desktop exports.

**Architecture:** Extract the reusable static brand primitives into a private `@hogsend/brand-media` package consumed by both Docs and a new `@hogsend/video` app. Remotion owns the 30fps frame clock; every visual state is a pure function of the current frame and campaign manifest. Voice generation is a separate cacheable preparation step, so Studio and rendering never call an API.

**Tech Stack:** React 19, TypeScript 5.9, Remotion, Vitest, OpenAI speech API, pnpm workspaces, Node 22.

**Global Constraints:** Keep all work on local branch `codex/og-template-spike`; do not push. Use `pnpm add ...@latest` for new dependencies. Do not use CSS animations, requestAnimationFrame, wall-clock timers, or live API calls during rendering. The default composition is exactly 450 frames at 30fps and completes its hook by frame 90. Generated audio and rendered media stay out of Git.

---

## File map

- `packages/brand-media/`: shared tokens, layouts, copy types, thermal frame primitives, and deterministic motion helpers.
- `apps/docs/lib/brand-template-*.ts`: compatibility re-exports from `@hogsend/brand-media`.
- `apps/docs/components/brand/brand-template-*.tsx`: Docs wrappers around shared React primitives with Docs asset URLs.
- `apps/video/src/index.ts`: Remotion entry point.
- `apps/video/src/root.tsx`: composition registrations for three formats.
- `apps/video/src/campaigns/`: typed 15-second campaign manifests.
- `apps/video/src/compositions/`: responsive video composition and frame-driven scene layers.
- `apps/video/src/lib/`: manifest validation, timing, paths, captions, voice cache, and render contracts.
- `apps/video/scripts/`: voice preparation and local multi-format renderer.
- `apps/video/public/`: copied brand textures/fonts and ignored generated voice cache.

### Task 1: Create the shared brand-media package

**Files:**
- Create: `packages/brand-media/package.json`
- Create: `packages/brand-media/tsconfig.json`
- Create: `packages/brand-media/src/index.ts`
- Create: `packages/brand-media/src/presets.ts`
- Create: `packages/brand-media/src/content.ts`
- Create: `packages/brand-media/src/motion.ts`
- Create: `packages/brand-media/src/presets.test.ts`
- Create: `packages/brand-media/src/motion.test.ts`

- [ ] Write tests asserting uniform frame insets, the 78% divider, upper-chamber content geometry, and clamped/eased motion values at before/start/middle/end/after frames.
- [ ] Run `pnpm --filter @hogsend/brand-media test` and confirm the missing implementation fails.
- [ ] Move the existing preset and content contracts into the package and add pure helpers `progress(frame, from, duration)`, `easeOutCubic(value)`, and `windowedProgress(frame, enter, hold, exit)`.
- [ ] Export the public contracts from `src/index.ts` and run package tests plus `pnpm --filter @hogsend/brand-media check-types`.
- [ ] Commit as `feat(brand): add shared brand media primitives`.

### Task 2: Share the actual Docs brand frame and content components

**Files:**
- Create: `packages/brand-media/src/brand-frame.tsx`
- Create: `packages/brand-media/src/brand-content.tsx`
- Create: `packages/brand-media/src/brand-frame.test.tsx`
- Modify: `packages/brand-media/src/index.ts`
- Modify: `apps/docs/package.json`
- Modify: `apps/docs/lib/brand-template-presets.ts`
- Modify: `apps/docs/lib/brand-template-content.ts`
- Modify: `apps/docs/components/brand/brand-template-canvas.tsx`
- Modify: `apps/docs/components/brand/brand-template-content.tsx`

- [ ] Write a render test proving the shared frame draws equal outer padding, places the divider at 78%, keeps copy in the upper chamber, and resolves both thermal assets through an injected `resolveAsset(path)` function.
- [ ] Run the focused test and confirm it fails before the components exist.
- [ ] Extract the brand canvas/content JSX without Tailwind dependencies; model visual animation as numeric `motion` props and default all values to a static frame.
- [ ] Replace Docs implementations with thin wrappers/re-exports that inject `/images/textures/...` URLs and preserve all current data attributes.
- [ ] Add `@hogsend/brand-media` with `pnpm --filter @hogsend/docs add @hogsend/brand-media@workspace:*` and run Docs brand tests, Docs typecheck, and package tests.
- [ ] Commit as `refactor(docs): share brand media components`.

### Task 3: Scaffold Remotion Studio and register formats

**Files:**
- Create: `apps/video/package.json`
- Create: `apps/video/tsconfig.json`
- Create: `apps/video/remotion.config.ts`
- Create: `apps/video/src/index.ts`
- Create: `apps/video/src/root.tsx`
- Create: `apps/video/src/lib/formats.ts`
- Create: `apps/video/src/lib/formats.test.ts`
- Create: `apps/video/public/images/textures/thermal-1.webp`
- Create: `apps/video/public/images/textures/thermal-2.webp`

- [ ] Write tests for `vertical=1080x1920`, `square=1080x1080`, `landscape=1920x1080`, all at 30fps and 450 frames.
- [ ] Run the test and confirm the format registry is absent.
- [ ] Create the private app and use pnpm to add current `remotion`, `@remotion/cli`, `@remotion/renderer`, React, types, Vitest, OpenAI, and the workspace brand package.
- [ ] Register `Hogsend-Codex-Vertical`, `Hogsend-Codex-Square`, and `Hogsend-Codex-Landscape` compositions from one format registry.
- [ ] Copy only the two existing thermal texture assets required by the composition and start Studio once to verify the entry point loads.
- [ ] Commit as `feat(video): scaffold remotion studio`.

### Task 4: Add the typed campaign and timing contract

**Files:**
- Create: `apps/video/src/lib/campaign.ts`
- Create: `apps/video/src/lib/campaign.test.ts`
- Create: `apps/video/src/campaigns/codex-campaign.ts`
- Create: `apps/video/src/campaigns/index.ts`

- [ ] Write validation tests for exact 450-frame duration, contiguous beats, first hook ending no later than frame 90, non-empty caption/voice text, and stable campaign lookup.
- [ ] Run tests and confirm the validator/campaign are missing.
- [ ] Implement typed `CampaignManifest`, `CampaignBeat`, and `CampaignAudio` contracts and the first four-beat script from the approved design.
- [ ] Reject gaps, overlaps, invalid formats, overlong hooks, and unknown campaign IDs with actionable errors.
- [ ] Run tests and typecheck.
- [ ] Commit as `feat(video): define codex campaign manifest`.

### Task 5: Build the deterministic 15-second composition

**Files:**
- Create: `apps/video/src/compositions/hogsend-campaign.tsx`
- Create: `apps/video/src/compositions/brand-background.tsx`
- Create: `apps/video/src/compositions/kinetic-copy.tsx`
- Create: `apps/video/src/compositions/codex-terminal.tsx`
- Create: `apps/video/src/compositions/progress-rail.tsx`
- Create: `apps/video/src/lib/scene-state.ts`
- Create: `apps/video/src/lib/scene-state.test.ts`
- Modify: `apps/video/src/root.tsx`

- [ ] Write frame snapshot tests at 0, 15, 45, 89, 90, 180, 300, 389, 390, and 449 for active beat, copy transform/opacity, thermal drift, terminal progress, and CTA state.
- [ ] Run tests and confirm scene-state is missing.
- [ ] Implement every animation as a pure numeric function of `useCurrentFrame()`: line draws, thermal drift, staggered word reveals, Codex terminal steps, result pulses, and CTA settle.
- [ ] Compose the shared `BrandFrame` with responsive scale/typography derived from composition dimensions; keep all primary text inside the upper chamber.
- [ ] Use `Sequence` for beat ownership and ensure the hook is readable during the first 90 frames.
- [ ] Run unit tests, typecheck, and render representative stills for all three formats.
- [ ] Commit as `feat(video): animate codex campaign`.

### Task 6: Add cached voice generation and captions

**Files:**
- Create: `apps/video/src/lib/voice.ts`
- Create: `apps/video/src/lib/voice.test.ts`
- Create: `apps/video/src/lib/captions.ts`
- Create: `apps/video/src/lib/captions.test.ts`
- Create: `apps/video/scripts/generate-voice.mjs`
- Create: `apps/video/public/audio/.gitignore`
- Modify: `apps/video/src/compositions/hogsend-campaign.tsx`
- Modify: `apps/video/package.json`

- [ ] Write tests for stable content hashes, cache paths, per-beat clip metadata, caption word timing, API-key-free cache hits, and clear cache-miss errors.
- [ ] Run tests and confirm voice/caption helpers are missing.
- [ ] Implement `voice:generate --campaign codex-campaign` using the OpenAI speech endpoint, configurable `OPENAI_TTS_MODEL`/`OPENAI_TTS_VOICE`, one clip per beat, and a JSON cache manifest. Include an explicit AI-voice disclosure in generated metadata.
- [ ] Add deterministic kinetic captions and Remotion audio sequences that consume only cached local files.
- [ ] Verify no secret value or generated audio is tracked and run tests/typecheck.
- [ ] Commit as `feat(video): add cached voice and captions`.

### Task 7: Add local rendering and Desktop exports

**Files:**
- Create: `apps/video/src/lib/output.ts`
- Create: `apps/video/src/lib/output.test.ts`
- Create: `apps/video/scripts/render.mjs`
- Modify: `apps/video/package.json`
- Modify: `.gitignore`

- [ ] Write tests for deterministic output names, Desktop default path, per-format composition IDs, overwrite behavior, and render manifest contents.
- [ ] Run tests and confirm output helpers are missing.
- [ ] Implement `render --campaign ... --format ...` and `render:all --campaign ... --desktop` using Remotion's renderer, producing MP4, WebM, poster PNG, and a render manifest in `~/Desktop/Hogsend Brand Videos/<campaign>/`.
- [ ] Fail before rendering when cached voice is requested but missing; allow `--no-voice` for a silent deterministic render.
- [ ] Run a silent all-format render, inspect duration/dimensions with `ffprobe`, and inspect the posters/contact sheet visually.
- [ ] Commit as `feat(video): add desktop render pipeline`.

### Task 8: Complete integration verification

**Files:**
- Modify only files required by discovered integration issues.

- [ ] Run `pnpm --filter @hogsend/brand-media test`, `pnpm --filter @hogsend/video test`, and focused Docs brand tests.
- [ ] Run typechecks for brand-media, video, and Docs; run `pnpm exec biome check` against all new/modified source files.
- [ ] Run the 450-frame silent render for vertical, square, and landscape; verify codec, 15.000-second duration, 30fps, dimensions, and final frame.
- [ ] Confirm the first 90 frames contain a legible hook, all text remains above the divider, outer borders have equal padding, and no CSS/wall-clock animation exists.
- [ ] Scan for `TODO`, placeholder copy, API keys, generated audio, and tracked render outputs.
- [ ] Commit only if verification requires fixes, then leave the local branch clean and unpushed.
