# Devtools

The unified [TanStack Devtools](https://tanstack.com/devtools) shell for this
app. One trigger, one panel host, every inspector — TanStack built-ins **and**
bespoke product panels — supplied through a single `plugins` array. Product code
never imports a specific inspector library; the dependency stops at the shell.

## Layout

| File | Role |
| --- | --- |
| `index.tsx` | Client-only entry point. Decides *when* the shell mounts: always in dev, opt-in via `?hs-devtools` in production. Mounted once in `app/layout.tsx`. |
| `shell.tsx` | The only module that imports `@tanstack/react-devtools`. Renders `<TanStackDevtools plugins={…} />`. |
| `plugins.tsx` | Assembles the `plugins` array — product panels live, built-in panels as a documented example. |
| `panels/*` | The panel components. `panel-ui.tsx` holds shared inline-styled primitives (no design-system coupling — a panel is a portable leaf). |

## Opening it

**In dev:** `pnpm dev`, then click the corner trigger (bottom-right) or press
**Ctrl + ~**. The shell persists its open/closed state and active tab to
`localStorage`, so it stays where you left it.

**In production:** it's opt-in. Append `?hs-devtools` to any URL —
e.g. `https://hogsend.com/?hs-devtools` — and the shell appears; the choice is
remembered in `localStorage`, so it sticks across navigation. This is what lets
you watch the live event tail against **real production traffic**. Hide it again
with `?hs-devtools=off`.

Because the entry gates the dynamic `import("./shell")` on that flag, a normal
production visitor never downloads the devtools bundle at all — zero page-weight
cost. (To show it to everyone in prod instead, render `<DevtoolsShell />`
unconditionally in `index.tsx`.)

## Adding a product panel

1. Write a component under `panels/` (see `analytics-panel.tsx` for a rich
   example that tails live PostHog events, or `hogsend-panel.tsx` for a lean
   one). Use the `panel-ui.tsx` primitives to stay lightweight.
2. Add an entry to `productPlugins()` in `plugins.tsx`:

   ```tsx
   { id: "my-panel", name: "My Panel", render: <MyPanel /> }
   ```

## Adding a built-in TanStack panel

This app uses neither TanStack Query nor Router, so those packages aren't
dependencies and the entries in `builtinPlugins()` stay commented. When you add
one of those libraries, wiring its panel is three lines:

```bash
pnpm add -D @tanstack/react-query-devtools
```

```tsx
// plugins.tsx — inside builtinPlugins()
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";

{ id: "tanstack-query", name: "TanStack Query", render: <ReactQueryDevtoolsPanel /> }
```

Import the **`*Panel`** export (the embeddable variant), not the standalone
floating `<...Devtools />` — the shell already provides the trigger and frame.
The panel reads its client from React context, so the shell must render inside
that library's provider (it does — it mounts in the root layout).
