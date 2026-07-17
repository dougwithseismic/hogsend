# Uniform frames, content examples, and ad carousel variants

## Goal

Refine the Hogsend brand template pack so every canvas has equal border padding on all four sides, then expand the deterministic renderer with polished text-bearing examples and a large set of article-led carousel ad variants for Meta, Reddit, and LinkedIn.

The final export contains 92 PNGs:

- 50 existing clean, signed, and colorway templates rerendered with uniform frames;
- 6 standalone design-system text examples;
- 36 carousel cards: 3 platforms × 3 campaign variants × 4 sequential cards.

Contact sheets and manifests are review artifacts and do not count toward the 92 images.

## Uniform frame geometry

The current renderer derives horizontal and vertical frame insets separately from canvas width and height. On landscape and banner formats this makes the left/right rails sit much farther from the edge than the top/bottom rails.

Replace that calculation with one optical inset per canvas:

```ts
const frameInset = clamp(
  Math.round(Math.min(width, height) * 0.045),
  24,
  64,
);
```

Use that exact pixel value for `frameInsetX` and `frameInsetY`. This makes all four outer borders equal within an image while scaling appropriately across stories, square posts, normal landscapes, and very wide banners. Interior structural rules remain composition details and are not part of the outer border contract.

All 50 existing exports are rerendered after this change. Safe areas remain platform-specific and independent of frame padding.

## Content rendering system

Keep `BrandTemplateCanvas` responsible only for the decorative background, frame, thermal layers, and safe-area geometry. Add a separate `BrandTemplateContent` component that receives a typed content model and renders design-system copy over the canvas.

The content system uses the same visual language as `apps/docs`:

- Inter through `var(--font-sans)` for display headlines;
- Geist Mono through `var(--font-mono)` for eyebrows, numbering, commands, and metadata;
- white headline hierarchy, muted white supporting copy, Hogsend red announcement accents, and green status/code accents;
- compact pills, thin borders, code panels, terminal prompts, and restrained tracking derived from the landing hero;
- no third-party platform logos and no invented UI chrome;
- content always stays inside the preset safe area and remains readable at feed-preview size.

The renderer supports four content layouts:

1. `editorial`: large headline, short support line, restrained eyebrow;
2. `code`: headline plus a compact TypeScript or command panel;
3. `steps`: ordered operational sequence with one emphasized step;
4. `cta`: decisive headline, command, URL, and subtle action cue.

## Standalone text examples

Create six examples in `examples/`:

| ID | Canvas | Layout | Copy |
| --- | --- | --- | --- |
| `og-product-logic` | 1200×630 | editorial | “Your customer lifecycle belongs in your repo.” |
| `youtube-lifecycle-automation` | 1280×720 | editorial + code | “Lifecycle automation that ships with your product.” |
| `linkedin-measure-keep-grow` | 1200×627 | steps | “Measure → Keep → Grow. In that order.” |
| `square-typed-tested-shipped` | 1080×1080 | editorial | “Your lifecycle logic. Typed. Tested. Shipped.” |
| `portrait-signup-to-retention` | 1080×1350 | steps | “From signup to retention—in your repo.” |
| `stream-building-live` | 1920×1080 | cta | “Building lifecycle systems live.” |

Each example includes a subtle `hogsend.com` signature. The command-bearing examples use `pnpm dlx create-hogsend@latest`.

## Carousel campaign structure

Every campaign is a four-card ordered story:

1. a question or clearly stated problem;
2. the operational principle or action to take;
3. how Hogsend makes the action practical;
4. a direct get-started card using `pnpm dlx create-hogsend@latest` and `hogsend.com`.

Every card includes platform, variant, and `01 / 04` sequencing metadata. Card ordering must remain fixed when uploaded.

All carousel cards are 1080×1080 PNGs. LinkedIn recommends 1080×1080 and allows 2–10 image cards. Reddit supports 2–6 carousel cards and square creative. Meta supports sequential carousel stories with up to ten cards; automatic card-order optimization should be disabled for these ordered narratives.

### Meta variants

Meta copy is benefit-led, immediately legible, and grounded in “Measure, keep, grow—in that order.”

#### `leaking-bucket` — default/ember editorial treatment

1. **Buying more signups before users stick?** Acquisition pours into the retention curve you already have.
2. **Measure → Keep → Grow.** See activation. Fix the drop-off. Then scale what retains.
3. **Turn behavior into action.** Hogsend triggers onboarding, stalled-usage nudges, and win-back from real product events.
4. **Ship the journey. Learn faster.** Start with one lifecycle journey today.

#### `after-signup` — violet signal treatment

1. **What happens after signup?** If the answer is vague, more traffic only creates more unknowns.
2. **Define activation first.** Instrument the moment users get value and the usage that predicts retention.
3. **React while intent is fresh.** Hogsend branches on behavior, waits durably, and sends only when the message is relevant.
4. **Start with one activation journey.** Put the first retention loop in your repo today.

#### `launch-spike` — cyan/acid technical treatment

1. **Another launch spike. Another slow decay?** Growth run backwards makes every campaign refill the same leak.
2. **Keep before you grow.** Shorten time-to-value, recover stalled users, and learn why they leave.
3. **Build retention into the product loop.** Hogsend keeps lifecycle logic next to the events and code it depends on.
4. **Turn the next signup into a retained user.** Ship your first journey today.

### Reddit variants

Reddit copy is direct, technical, and grounded in the lifecycle-silo and event-naming articles.

#### `one-person-silo` — default/ember editorial treatment

1. **Does your lifecycle stack live in one person’s browser tabs?** Private shorthand. No docs. One login. Revenue attached.
2. **Move journeys into the repo.** Readable files, normal diffs, and reviews by the people who know the edge cases.
3. **Give the code a runtime.** Hogsend handles durable waits, branches, suppression, tracking, and provider swaps.
4. **Read the code. Ship one journey.** Start with `pnpm dlx create-hogsend@latest`.

#### `silent-drift` — violet signal treatment

1. **Ever had a journey quietly stop firing?** `SignUp`, `sign_up`, and `user_signed_up` are not a tracking plan.
2. **Share one event vocabulary.** The product emits `Events.TRIAL_STARTED`; the journey imports the same constant.
3. **Let the compiler find drift.** Typed events and testable journeys turn silent breaks into failed builds.
4. **Replace data archaeology with a PR.** Put the journey next to the event today.

#### `clock-speed` — cyan/acid technical treatment

1. **Your product ships daily. Why does lifecycle still move at click-speed?** Every feature changes behavior, events, and what “activated” means.
2. **Let agents work on lifecycle too.** Code can be written, reviewed, tested, and reverted. A private canvas cannot.
3. **Keep authorship in the repo.** Hogsend Studio stays the read surface; TypeScript stays the source of truth.
4. **Bring lifecycle up to product speed.** Ship the first journey today.

### LinkedIn variants

LinkedIn copy is operational and executive-legible, grounded in “Shipping is not launching” and the lifecycle ownership problem.

#### `shipping-not-launching` — default/ember editorial treatment

1. **Your team merged the feature. Did the right users find out?** Shipping is a repo event. Launching is a distribution event.
2. **Launch inside-out.** Start with users who hit the problem, then relevant users, then the public.
3. **Make relevance executable.** Hogsend triggers from behavior, gates by segment, and sequences every touch.
4. **Make “users find out” part of done.** Ship the first launch journey today.

#### `owner-bottleneck` — violet signal treatment

1. **Can anyone besides one operator change your lifecycle layer?** Every trigger, condition, and message queues behind one owner.
2. **Make lifecycle shared product logic.** Version it, review it, test it, and let domain experts approve the edges.
3. **Separate authorship from visibility.** Journeys live in code; teams monitor state, sends, and performance in Studio.
4. **Remove the bottleneck without losing control.** Move one journey into the repo today.

#### `launch-pipeline` — cyan/acid technical treatment

1. **A launch is a pipeline, not a post.** The public announcement is the smallest audience likely to convert.
2. **Build the queue before launch day.** Problem segment, relevant users, public distribution—in that order.
3. **Connect product events to the pipeline.** Hogsend targets users who felt the limitation and tracks what happens next.
4. **Engineer repeatable distribution.** Start with one launch journey today.

## Article grounding

Copy and claims come from the four repository articles:

- `apps/docs/content/articles/lifecycle-is-product-logic.mdx`
- `apps/docs/content/articles/event-naming-is-a-growth-decision.mdx`
- `apps/docs/content/articles/gtm-for-engineers-shipping-is-not-launching.mdx`
- `apps/docs/content/articles/measure-keep-grow.mdx`

The ads paraphrase these articles rather than introducing unsupported product claims.

## Output organization

Keep the existing blank-template directories. Add:

```text
examples/
campaigns/
  meta/
    leaking-bucket/
    after-signup/
    launch-spike/
  reddit/
    one-person-silo/
    silent-drift/
    clock-speed/
  linkedin/
    shipping-not-launching/
    owner-bottleneck/
    launch-pipeline/
contact-sheets/
  examples.png
  meta.png
  reddit.png
  linkedin.png
  campaigns.png
```

Carousel filenames start with their ordered card number, for example `01-problem.png`, `02-action.png`, `03-hogsend.png`, and `04-get-started.png`.

The repository and `~/Desktop/Hogsend Brand Templates/` contain matching PNGs and manifests. The main manifest contains 92 unique image entries and distinguishes `template`, `example`, and `campaign` jobs.

## Rendering and validation

Extend the preview route and renderer to resolve content by stable example or campaign identifiers. The rendering pipeline continues to wait for fonts and thermal assets, isolate application chrome, and capture exact canvas bounds.

Automated checks cover:

- equal `frameInsetX` and `frameInsetY` for every preset;
- frame inset clamp bounds of 24–64px;
- exact 92-job count and unique output paths;
- 50 template, 6 example, and 36 campaign jobs;
- four sequential cards for every platform/variant pair;
- exact dimensions and platform-safe file sizes under 10 MB per carousel card;
- content confined to its safe area with no text overflow;
- only signed templates and intentional content jobs contain `hogsend.com`;
- transparent stream-overlay alpha behavior remains intact;
- repository/Desktop byte parity;
- visual inspection of every contact sheet and representative full-resolution cards.

## Boundaries

- No Ads Manager upload, campaign launch, spend, or external mutation.
- No editable browser design tool or CMS.
- No platform logos or imitated platform UI.
- No changes to live landing-page content.
- No merge or Git push unless explicitly requested.

## Current platform references

- Meta carousel format: <https://www.facebook.com/business/ads/carousel-ad-format>
- Reddit carousel format: <https://www.business.reddit.com/advertise/ad-types/carousel-ads>
- LinkedIn carousel specifications: <https://www.linkedin.com/help/linkedin/answer/a427022/carousel-image-ads-advertising-specifications?lang=en>
