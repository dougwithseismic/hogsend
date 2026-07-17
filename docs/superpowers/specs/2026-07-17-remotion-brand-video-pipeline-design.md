# Remotion brand video pipeline

## Goal

Add a reusable, local-first Remotion production system to the Hogsend monorepo. The first deliverable is a high-fidelity 15-second social ad with a spoken and visual hook completed within the first three seconds. The system must reuse the existing brand-template geometry, thermal assets, palettes, typography, and campaign data rather than creating a separate video design language.

The infrastructure is the primary deliverable. One polished “Codex builds the campaign” composition proves the pipeline, but every boundary must support additional scripts, campaign variants, generated imagery, voices, and aspect ratios without copying composition code.

## Product decisions

- Duration: exactly 15 seconds.
- Frame rate: 30fps, for exactly 450 frames.
- Primary canvas: 1080×1920 vertical social video.
- Derived canvases: 1080×1080 square and 1920×1080 landscape.
- Hook deadline: the first spoken and visual claim resolves by frame 90.
- Voice: confident product-builder delivery, with kinetic captions so the video remains understandable while muted.
- Motion: animation-heavy, but restrained by the existing Hogsend design system rather than generic motion-template effects.
- Render mode: deterministic and local. Rendering never calls a live API.
- Initial output: MP4, WebM, and poster PNGs exported to `~/Desktop/Hogsend Brand Videos/`.

## Approaches considered

### Dedicated video app and shared brand package — selected

Create `apps/video` for Remotion Studio, compositions, asset preparation, validation, and export. Create a private workspace package, `packages/brand-media`, for the brand primitives shared by `apps/docs` and `apps/video`.

This requires a focused extraction from `apps/docs`, but it gives Remotion a clean runtime, prevents Next.js from becoming a video-render dependency, and makes the static and motion pipelines consume the same geometry and content contracts.

### Remotion inside `apps/docs`

This has the lowest initial file count but couples video tooling, FFmpeg/render dependencies, and Studio configuration to the public docs application. It also makes local video failures part of docs dependency resolution. Reject this approach.

### Animate exported PNGs

This can produce a quick slideshow, but it cannot reflow typography, preserve platform safe areas, drive thermal layers independently, or make high-fidelity responsive transitions. Reject this approach except as an optional image-card scene type.

## Workspace architecture

### `packages/brand-media`

This private package is the canonical brand-media contract. It has no Next.js or Remotion dependency.

It owns:

- template dimensions, palettes, frame geometry, upper content chamber, and safe areas;
- campaign and standalone copy data;
- asset identifiers for thermal textures and fonts;
- shared React primitives for the frame, thermal field, dot grid, headline, support copy, metadata, and signature;
- a required asset resolver interface so docs can resolve `/images/...` while Remotion can use `staticFile(...)`;
- a `BrandMotionState` input containing explicit numeric opacity, scale, translation, rotation, blur, and thermal-blend values.

The shared React components do not start CSS animations or read wall-clock time. `apps/docs` supplies a static default motion state. `apps/video` derives motion state from the current Remotion frame. Existing docs imports may be retained through thin re-export files during the extraction so unrelated call sites do not churn.

### `apps/video`

This private workspace app owns:

- the Remotion root and Studio configuration;
- responsive video compositions;
- typed campaign manifests and scene definitions;
- frame-driven motion utilities;
- audio and caption preparation;
- render validation and Desktop export;
- the first polished `codex-campaign` composition.

Proposed commands:

```text
pnpm --filter @hogsend/video studio
pnpm --filter @hogsend/video voice:generate --campaign codex-campaign
pnpm --filter @hogsend/video render --campaign codex-campaign --format vertical
pnpm --filter @hogsend/video render:all --campaign codex-campaign --desktop
pnpm --filter @hogsend/video test
```

Dependencies must be installed with `pnpm add <package>@latest` from the correct workspace rather than written directly into `package.json`.

## Composition data model

Every video is driven by a schema-validated manifest. The manifest contains content and timing, not JSX implementation details.

```ts
type BrandVideoCampaign = {
  id: string;
  durationInFrames: 450;
  fps: 30;
  palette: BrandTemplatePaletteKey;
  formats: readonly ["vertical", "square", "landscape"];
  music?: AudioAsset;
  beats: readonly BrandVideoBeat[];
};

type BrandVideoBeat = {
  id: string;
  from: number;
  durationInFrames: number;
  role: "hook" | "problem" | "proof" | "payoff" | "cta";
  voice: {
    text: string;
    asset: string;
  };
  caption: {
    text: string;
    emphasis: readonly string[];
  };
  visual: BrandSceneSpec;
};
```

Manifest validation requires contiguous or intentionally overlapping beats, no content after frame 449, a hook ending by frame 90, known asset references, supported palettes, and exact format dimensions.

## Motion system

Remotion owns the clock. Every visual property is a pure function of `useCurrentFrame()` and the composition fps. CSS transitions, CSS keyframes, `requestAnimationFrame`, `Date.now()`, and unseeded randomness are forbidden in renderable components.

The motion layer contains:

- named timing curves for `enter`, `settle`, `impact`, `glitch`, `exit`, and `thermalDrift`;
- frame-based `spring` and `interpolate` helpers for ordinary motion;
- optional GSAP easing functions for art-directed curves;
- no independently playing GSAP global timeline;
- a scene-local motion resolver that returns a `BrandMotionState` for the current frame;
- seeded particles and noise when variation is required.

If a GSAP timeline is used for authoring a complex sequence, it must remain paused and be sampled at the exact Remotion timestamp. It may not mutate DOM on an independent ticker. Prefer pure easing and motion-state calculation whenever the same effect is practical.

## First composition: `codex-campaign`

The composition demonstrates the complete infrastructure rather than behaving like a four-card slideshow.

### Frames 0–90: hook

- Spoken: “Your product knows what customers do. Why doesn’t your marketing?”
- Oversized kinetic type lands immediately; no logo intro.
- The existing frame rails draw on, the thermal field surges behind the question, and the final phrase resolves before frame 90.
- Caption emphasis: `product knows` and `your marketing`.

### Frames 90–250: Codex builds

- Spoken: “Tell Codex the outcome. It builds the Hogsend follow-up, tests it, and shows every step.”
- A concise prompt becomes a typed campaign manifest, then a Hogsend follow-up flow.
- File, test, and output states appear as designed product cards, not a literal terminal recording.
- Motion uses masked wipes, line draws, text splitting, thermal refraction, and tightly timed status changes.

### Frames 250–390: multi-format payoff

- Spoken: “Then ship the campaign with your product.”
- Vertical, square, and landscape renders fan out from the same manifest.
- Existing Meta, Reddit, and LinkedIn visual language appears as responsive outputs.
- The voice and captions leave enough visual hold time for the audience to understand the transformation.

### Frames 390–450: CTA

- Spoken: “Build it with Hogsend.”
- The final frame holds `hogsend.com`, a subtle command treatment, and a small AI-voice disclosure.
- Motion settles rather than cutting away at the final frame, so the poster frame is usable.

## Voice and audio pipeline

Voice generation is a preparation step, never part of Studio playback or rendering.

Each beat is generated as its own audio file. This makes scene starts exact, allows one line to be regenerated without changing the rest, and avoids depending on inferred word timestamps. Captions use the same beat text and explicit emphasis ranges.

The OpenAI implementation uses the Audio API speech endpoint through a small provider interface. The model is configurable through `OPENAI_TTS_MODEL` because model availability changes; the default follows the currently documented speech-generation guide. Voice, instructions, output format, and normalized script text are included in a content hash. An existing matching asset is reused unless `--force` is supplied.

The voice-generation command:

1. validates the campaign manifest;
2. requires `OPENAI_API_KEY` only for uncached lines;
3. generates into a temporary file;
4. validates that the file is readable and fits its beat duration;
5. atomically moves it to the hashed asset path;
6. writes a local voice manifest containing duration and generation settings.

If a line is too long, generation fails with the beat ID and measured overrun. The renderer does not silently speed up speech. The user-facing video or accompanying post must clearly disclose that the voice is AI-generated, as required by the OpenAI speech-generation guidance.

Music and sound effects are optional local assets. The voice remains intelligible after mixing, and the composition remains coherent with audio muted.

## Optional generated imagery

Generated images are an asset provider, not a composition dependency. A scene may reference an approved local image in its manifest. Image generation occurs before rendering and writes a provenance sidecar containing the prompt, dimensions, and generation timestamp.

The first composition does not require a generated hero image. It proves high fidelity using the real Hogsend thermal assets, typography, campaign data, and responsive outputs. This keeps the infrastructure spike focused while leaving a clean path for future product metaphors and campaign-specific art.

## Responsive composition rules

All three formats use the same beats, voice, and semantic visual roles. They do not scale one canvas mechanically.

- Vertical uses stacked scenes, large captions, and center-weighted motion.
- Square uses the existing upper content chamber and lower rail for metadata and CTA rhythm.
- Landscape uses a two-column proof scene and keeps critical content within central platform-safe bounds.

The scene renderer receives an aspect-class layout object. Brand primitives consume layout slots rather than reading viewport ratios ad hoc. Text fitting uses the same measured overflow checks as the static renderer and may select a compact typography density without changing copy.

## Asset and render flow

```text
brand campaign manifest
  -> schema and timing validation
  -> cached voice preparation
  -> local asset manifest
  -> Remotion Studio preview
  -> deterministic frame validation
  -> MP4, WebM, and poster rendering
  -> Desktop campaign directory and render manifest
```

The render command writes to a temporary directory and only replaces a completed output after the render, metadata inspection, and poster extraction succeed. A render manifest records campaign ID, git commit, format, dimensions, fps, frame count, codec, audio presence, source hashes, and output hashes.

## Validation and testing

Automated checks cover:

- the shared brand package has no Next.js or Remotion dependency;
- the docs templates retain their current geometry and screenshot output contract after extraction;
- every campaign is exactly 450 frames at 30fps;
- the hook ends by frame 90;
- beats and audio clips remain within the composition bounds;
- every format resolves to exact approved dimensions;
- all assets exist before Studio or rendering begins;
- renderable code contains no wall-clock animation or unseeded randomness;
- text and captions remain within aspect-specific safe regions;
- representative frames render at 0, 45, 89, 90, 180, 300, 389, and 449;
- rendering the same representative frame twice produces the same image hash;
- MP4 and WebM outputs have the expected duration, dimensions, frame rate, and audio stream;
- poster frames match frame 449 and remain usable as standalone social images;
- Desktop outputs and render manifests match repository-side temporary results before cleanup.

Visual review includes the hook at feed-preview size, every aspect ratio, caption readability, voice/music balance, transitions at beat boundaries, and the final CTA hold.

## Failure behavior

- Invalid timing or content fails before Studio registration.
- Missing fonts, textures, voice clips, or images report the exact manifest path.
- Voice generation never overwrites a valid cached asset after a failed request.
- Audio overrun identifies the beat and measured duration.
- Render failures preserve logs and temporary files but do not replace the last successful export.
- The render command never makes network calls.
- Missing API credentials only block uncached voice preparation; silent Studio layout work and existing cached campaigns remain usable.

## Git and output boundaries

- `apps/video/out/`, encoded videos, temporary frames, and Desktop exports are ignored.
- Small source assets, campaign manifests, approved voice clips for the demonstration, and poster fixtures may be committed when licensing and size are acceptable.
- No upload to Meta, Reddit, LinkedIn, YouTube, or any ad account is part of this work.
- No remote branch or push is created unless explicitly requested.

## Sources

- Remotion frame hook: <https://github.com/remotion-dev/remotion/blob/main/packages/core/src/use-current-frame.ts>
- GSAP timeline controls: <https://gsap.com/docs/v3/GSAP/Timeline/>
- OpenAI speech-generation guide: <https://developers.openai.com/api/docs/guides/text-to-speech>
- OpenAI TTS model catalog: <https://developers.openai.com/api/docs/models/all>
