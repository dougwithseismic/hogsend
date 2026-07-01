# @hogsend/inspector

Click any element in your running app to open its exact source line in your
editor — dev-only, built for **Next.js + Turbopack + React 19**, where a
rendered DOM node otherwise carries no path back to its source.

It works by stamping each JSX element with a `data-hs-source="file:line:col"`
attribute at build time (dev only), then a lightweight overlay maps a clicked
element back to that location.

> Status: dogfooded inside this repo (`apps/docs`). Inline text editing
> (select text → write it back to source) is the next milestone.

## Setup

**1. Wrap your Next config** (adds the dev-only stamping loader; no-op in prod):

```js
// next.config.mjs
import { withInspector } from "@hogsend/inspector/next";

export default withInspector(nextConfig, {
  include: ["/components/"], // which files to stamp (path fragments)
});
```

**2. Mount the overlay** (client, dev only):

```tsx
import { InspectorOverlay } from "@hogsend/inspector";

// in a client component rendered in your root layout
{process.env.NODE_ENV !== "production" ? <InspectorOverlay /> : null}
```

**3. Add the open-in-editor route** (dev only, same-origin + path-allowlisted):

```ts
// app/api/devtools/open/route.ts
import { createOpenHandler } from "@hogsend/inspector/server";

export const POST = createOpenHandler();
```

## Use

Run your dev server, then **hold Option/Alt** and hover any stamped element —
it highlights with its source location. **Click** to open that line in your
editor (`cursor`/`code`; set `HS_EDITOR` to override).

## Safety

Everything is dev-only: the stamping loader is never wired in production, and
the open route hard-404s in a production build, requires same-origin requests,
and refuses any path outside your project root.
