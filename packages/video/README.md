# @hogsend/video

Analytics-first video player: one normalized watch-depth event contract across
YouTube, Vimeo, and native HTML5 — with a pluggable emitter that works with any
analytics backend (Hogsend, PostHog, GA4, Segment, or your own sink). Zero
dependencies; the provider SDKs lazy-load from their own CDNs.

## Events

`video.started` · `video.play` · `video.pause` · `video.seek` ·
`video.progress` (at milestones, default 25/50/75/90%) · `video.completed` ·
`video.replay` · `video.ratechange` · `video.volumechange` · `video.buffering`

Every event carries the full `PlayerState` snapshot plus flattened
`properties` (`percentWatched`, `currentTime`, `duration`, source metadata,
and your context bag). `percentWatched` is the **max depth reached** — it is
monotonic and immune to seeking back.

## React

```tsx
import { VideoPlayer } from "@hogsend/video/react";
import { createHogsendEmitter } from "@hogsend/video/hogsend";

<VideoPlayer
  src={{ youtube: "dQw4w9WgXcQ" }}
  title="Product demo"
  emitter={createHogsendEmitter({ capture: hogsend.capture })}
  context={{ page: "pricing" }}
/>;
```

Any capture-shaped function works — PostHog is the same one-liner:

```ts
createHogsendEmitter({ capture: (e, p) => posthog.capture(e, p) });
```

## Core (framework-agnostic)

```ts
import { createVideoTracker } from "@hogsend/video";
import { createHtml5Adapter } from "@hogsend/video/html5";

const tracker = createVideoTracker({
  emitter: (event) => myAnalytics.track(event.name, event.properties),
  milestones: [10, 50, 95],
});
tracker.attach(createHtml5Adapter(videoElement, { title: "Demo" }));

tracker.getState();          // full player state, any time
tracker.on("*", handler);    // custom JS over every event
tracker.setContext({ variant: "b" }); // tag the viewer/session
```

Write your own source by implementing `ProviderAdapter` (push raw signals into
`AdapterSink`); the tracker owns milestones, dedupe, replay detection, and
emission.
