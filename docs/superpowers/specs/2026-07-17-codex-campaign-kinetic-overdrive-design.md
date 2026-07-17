# Codex campaign: Kinetic Overdrive

## Outcome

Re-cut the existing 15-second `codex-campaign` as a high-energy social ad. The new version must interrupt the feed in the first second, communicate the customer-marketing problem by three seconds, demonstrate Codex and the real Hogsend product, and finish on a readable `hogsend.com` hold.

The selected direction is **Kinetic Overdrive**: hard cuts, oversized word impacts, aggressive product crops, snap zooms, thermal impact frames, and a dense sound-design rhythm. The energy comes from editorial timing and real product evidence, not decorative motion alone.

## Message

Avoid abstract lifecycle terminology. Use direct language that a marketer or founder understands immediately:

- Problem: **Stop chasing customers by hand.**
- Action: **Tell Codex what should happen.**
- Proof: **It builds. Tests. Ships.**
- Payoff: **Customer marketing, built into your product.**
- CTA: **hogsend.com**

Voice script, when generated:

> Stop chasing customers by hand. Tell Codex what should happen. It builds the marketing, tests every path, and ships it with your product. Build with Hogsend.

The composition must remain effective muted. Every spoken idea has an onscreen equivalent, but captions are treated as designed kinetic copy rather than a persistent subtitle strip.

## 15-second edit

The edit remains 450 frames at 30fps. Shot boundaries are deterministic and shared across aspect ratios.

| Frames | Time | Picture | Onscreen copy |
|---:|---:|---|---|
| 0–12 | 0.0–0.4s | Thermal impact frame, rail flash, immediate scale punch | `STOP.` |
| 12–32 | 0.4–1.1s | Hard cut, oversized type collides from opposite edges | `CHASING` |
| 32–54 | 1.1–1.8s | Second impact and tighter camera jump | `CUSTOMERS` |
| 54–76 | 1.8–2.5s | Macro campaign/product crop with red strike-through gesture | `BY HAND.` |
| 76–96 | 2.5–3.2s | Thermal whip into a concise prompt card | `TELL CODEX` |
| 96–122 | 3.2–4.1s | Prompt types in with a rapid cursor chase | `what should happen` |
| 122–148 | 4.1–4.9s | Generated journey file snaps into place | `BUILDS.` |
| 148–174 | 4.9–5.8s | Test results cascade and lock green | `TESTS.` |
| 174–204 | 5.8–6.8s | Real Journeys screen, fast push toward active rows | `Journeys` |
| 204–232 | 6.8–7.7s | Real Contacts screen, macro crop and lateral whip | `The right people` |
| 232–260 | 7.7–8.7s | Real Campaigns screen, jump zoom into status | `The right message` |
| 260–290 | 8.7–9.7s | Real Sends screen, success state lands | `SHIPS.` |
| 290–314 | 9.7–10.5s | Overview product shot with 3D perspective snap | `YOUR MARKETING.` |
| 314–338 | 10.5–11.3s | Journey/product crop with opposite camera direction | `YOUR PRODUCT.` |
| 338–364 | 11.3–12.1s | Four-frame product strobe: overview, journeys, campaigns, sends | `ONE SYSTEM.` |
| 364–392 | 12.1–13.1s | Multi-panel product stack collapses into the brand frame | `BUILT TOGETHER.` |
| 392–420 | 13.1–14.0s | Thermal field settles; final promise enters | `Customer marketing, built in.` |
| 420–450 | 14.0–15.0s | Stable end card and command treatment | `hogsend.com` |

The first three seconds use four distinct shots. No intro logo, slow establishment, or empty thermal hold precedes the hook.

## Product shots

Use the real Studio assets already published in `apps/docs/public/images/studio/`:

- `08-journeys-overview.png`
- `10-contacts-directory.png`
- `07-campaigns-list.png`
- `04-sends-history.png`
- `02-overview-dashboard.png`

Add a small deterministic asset-sync step into `marketing/video` so the composition does not depend on a Next.js public directory at render time. Preserve the source pixels; crops and color treatment happen in Remotion.

Each product shot gets a specific focal point per aspect ratio. Landscape shows enough surrounding UI to establish the product. Square uses medium crops. Vertical uses macro crops and may split one screenshot into two sequential focal regions. Product text should remain readable when it carries proof; the fastest strobe shots are texture and recognition, not reading moments.

## Motion language

- Use 16–20 visible cuts across 15 seconds.
- Alternate camera direction between neighboring shots to create propulsion.
- Snap zooms use short ease-out curves with 8–18% scale changes; macro product hits may reach 35%.
- Use one- or two-frame thermal flashes at major word impacts, never more than six times.
- Use directional wipes only as cut punctuation. They must not cover readable product UI for more than four frames.
- Oversized copy may clip intentionally at the canvas edge, but its key noun remains legible.
- Keep all content above the lower horizontal rail. The final CTA has equal frame padding on every side.
- All motion is calculated from Remotion frames. No CSS keyframes or independently playing GSAP ticker.

## Sound and voice

The silent render remains valid. When audio is enabled, use three layers:

1. Optional cached OpenAI voice, generated beat-by-beat through the existing voice pipeline.
2. A low, restrained rhythmic bed that does not compete with speech.
3. Local impact, tick, riser, and whoosh effects aligned to the edit markers.

The first impact lands at frame 0. Word hits at frames 12, 32, 54, 122, 148, and 260 receive distinct but related accents. Product changes use lighter ticks so the mix does not become exhausting. The final second drops most effects and lets the CTA breathe.

No system-generated fallback voice is permitted. If cached OpenAI voice assets are absent, the render is silent except for explicitly supplied licensed/local sound assets.

## Implementation shape

Refactor the four long scene components into shot-sized components and a typed edit list. The edit list owns frame ranges, shot names, and audio markers. Reusable primitives should cover:

- impact words;
- product screenshot crops;
- snap-zoom camera transforms;
- one-frame thermal flashes;
- directional cut wipes;
- prompt, file, and test proof cards;
- the final product stack and CTA.

Keep the existing `codex-campaign` composition ID and three registered aspect ratios so current render commands continue to work.

## Acceptance criteria

- Hook is visible on frame 0 and the full problem is understood by frame 76.
- At least four real Hogsend product screens appear before the CTA.
- There are 16–20 visible cuts, including at least four within the first three seconds.
- Product crops remain intentional in landscape, square, and vertical formats.
- No content crosses the lower frame rail; final outer padding is visually equal.
- The muted render communicates the complete problem, action, proof, and CTA.
- Missing voice assets do not break a silent render.
- Motion remains deterministic under Remotion rendering.
- Existing campaign validation, composition discovery, tests, typechecks, and media verification remain green.
