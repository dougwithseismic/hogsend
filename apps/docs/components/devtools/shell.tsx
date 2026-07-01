"use client";

import { TanStackDevtools } from "@tanstack/react-devtools";
import { buildDevtoolsPlugins } from "./plugins";

/**
 * DevtoolsShell — the unified TanStack Devtools shell. One trigger, one panel
 * host, every inspector (built-in + product) supplied through `plugins`. This
 * is the only module that imports `@tanstack/react-devtools`, so the dependency
 * on that specific inspector library stops here and never leaks into product
 * code. It's lazy-loaded and client-only; `./index.tsx` decides WHEN it mounts
 * (always in dev, opt-in via `?hs-devtools` in production).
 */
export function DevtoolsShell() {
  return (
    <TanStackDevtools
      plugins={buildDevtoolsPlugins()}
      config={{
        // Start closed; the shell persists this + the active tab to
        // localStorage after first use, so these are initial values only.
        defaultOpen: false,
        // Toggle with Ctrl+~ (the shell default) or the corner trigger.
        position: "bottom-right",
        panelLocation: "bottom",
      }}
    />
  );
}
