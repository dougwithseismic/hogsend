# @hogsend/inspector

Click any element in your running app to edit its static text or Tailwind class
list in place, or open its exact source line in your editor — dev-only, built for
**Next.js + Turbopack + React 19**, where a rendered DOM node otherwise carries
no path back to its source.

It works by stamping each JSX element with a `data-hs-source="file:line:col"`
attribute at build time (dev only), then a lightweight overlay maps a clicked
element back to that location.

> Status: dogfooded across this repo's `apps/docs` site.

## Setup

**1. Wrap your Next config** (adds the dev-only stamping loader; no-op in prod):

```js
// next.config.mjs
import { withInspector } from "@hogsend/inspector/next";

export default withInspector(nextConfig, {
  include: ["/apps/docs/"], // app-local TSX files to stamp
});
```

**2. Mount the overlay** (client, dev only):

```tsx
import { InspectorOverlay } from "@hogsend/inspector";

// in a client component rendered in your root layout
{process.env.NODE_ENV !== "production" ? <InspectorOverlay /> : null}
```

**3. Add the source routes** (dev only, same-origin + path-allowlisted):

```ts
// app/api/devtools/open/route.ts
import { createOpenHandler } from "@hogsend/inspector/server";

export const POST = createOpenHandler();
```

```ts
// app/api/devtools/edit/route.ts
import { createEditHandler } from "@hogsend/inspector/server";

export const POST = createEditHandler();
```

```ts
// app/api/devtools/style/route.ts
import { createStyleHandler } from "@hogsend/inspector/server";

export const POST = createStyleHandler();
```

## Use

Run your dev server, then **hold Option/Alt** and hover any stamped element —
it highlights with its source location.

- **Click** static JSX text to edit it in place.
- Press **Enter** to write the edit back to source, or **Escape** to cancel.
- **Command-click** (macOS) or **Control-click** (Windows/Linux) to edit a
  direct static `className="..."`. Existing compiled Tailwind utilities preview
  immediately; newly introduced utilities appear after save and HMR.
- In the class editor, press **Command/Control + Enter** to save or **Escape** to
  cancel.
- **Shift-click** to open the source line in your editor (`cursor` by default;
  set `HS_EDITOR` to override).

Inline editing intentionally handles direct, static JSX text only. Text from
expressions, MDX content, props, computed classes (`cn(...)`, conditionals, or
template expressions), CSS selectors, and structural changes should be changed
after opening the source instead. Class preview is disabled when runtime code
has merged extra classes, so the editor cannot accidentally erase them.

## Safety

Everything is dev-only: the stamping loader is never wired in production, and
the source routes hard-404 in a production build, require same-origin requests,
and refuse any path outside your project root. Do not expose a write-enabled
development server publicly without an additional access gate.
