"use client";

import type { TanStackDevtoolsReactPlugin } from "@tanstack/react-devtools";
import { AnalyticsDevtoolsPanel } from "./panels/analytics-panel";
import { HogsendDevtoolsPanel } from "./panels/hogsend-panel";

/**
 * The plugins array is the whole contract of the unified devtools shell: every
 * inspector — a built-in TanStack panel or a bespoke product panel — is just an
 * entry here. The shell hosts them all under one trigger, so product code never
 * imports (or depends on) any single library's inspector. To add a panel you
 * add an object; to remove one you delete it. Nothing else changes.
 *
 * Each entry is a `TanStackDevtoolsReactPlugin`:
 *   - `id`     — stable key (used for persistence of the active tab)
 *   - `name`   — label shown in the shell's tab strip (string or a React node)
 *   - `render` — a React element, or `() => <Panel />` for lazy render
 */

/**
 * Product-specific panels. These read this app's own runtime (PostHog, the
 * Hogsend client) and ship with it — they are the reason to own the shell.
 */
function productPlugins(): Array<TanStackDevtoolsReactPlugin> {
  return [
    {
      id: "hogsend-analytics",
      name: "Analytics",
      render: <AnalyticsDevtoolsPanel />,
    },
    {
      id: "hogsend-feed",
      name: "Hogsend",
      render: <HogsendDevtoolsPanel />,
    },
  ];
}

/**
 * Built-in TanStack panels. This app doesn't use TanStack Query or Router, so
 * those packages aren't dependencies and the entries stay commented — but this
 * is the EXACT, copy-paste shape for mounting them. Once you add a library:
 *
 *   1. install its devtools panel, e.g.
 *        pnpm add -D @tanstack/react-query-devtools
 *        pnpm add -D @tanstack/react-router-devtools
 *   2. import the *Panel* export (the embeddable variant — NOT the standalone
 *      floating `<...Devtools />`, which renders its own trigger)
 *   3. add an entry to the array returned below
 *
 * The panels read the live client from React context, so they must render
 * inside the app's providers — which they do, since the shell mounts in the
 * root layout under `QueryClientProvider` / `RouterProvider`.
 */
function builtinPlugins(): Array<TanStackDevtoolsReactPlugin> {
  return [
    // import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
    // {
    //   id: "tanstack-query",
    //   name: "TanStack Query",
    //   render: <ReactQueryDevtoolsPanel />,
    // },
    // import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
    // {
    //   id: "tanstack-router",
    //   name: "TanStack Router",
    //   // `render` may be a thunk when a panel needs per-mount setup:
    //   render: () => <TanStackRouterDevtoolsPanel router={router} />,
    // },
  ];
}

/**
 * Assemble the full plugins array. Built-in panels first (framework internals),
 * then product panels (app internals) — a conventional ordering, not a
 * requirement. Callers can splice in more via `extra` without editing here.
 */
export function buildDevtoolsPlugins(
  extra: Array<TanStackDevtoolsReactPlugin> = [],
): Array<TanStackDevtoolsReactPlugin> {
  return [...builtinPlugins(), ...productPlugins(), ...extra];
}
