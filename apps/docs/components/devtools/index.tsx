"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

/**
 * DevTools — mounts the unified TanStack Devtools shell.
 *
 * Availability:
 *  - Development: always on.
 *  - Production: opt-in. The shell — and the whole devtools library — is only
 *    downloaded once the visitor appends `?hs-devtools` to the URL; the choice
 *    is then remembered in localStorage so it survives navigation. Normal
 *    visitors never load a byte of it (the dynamic import never runs), so there
 *    is no page-weight cost and no devtools trigger on the live marketing site.
 *    Turn it back off with `?hs-devtools=off`.
 *
 * This is what makes the live event inspector usable against PRODUCTION traffic
 * without shipping a devtools UI to every real visitor. To instead show it to
 * everyone in prod, delete the flag gate and render `<DevtoolsShell />`
 * unconditionally.
 *
 * Client-only: the shell touches `document`/`localStorage`, so it loads via
 * `next/dynamic` with `ssr: false`.
 */

const DevtoolsShell = dynamic(
  () => import("./shell").then((m) => m.DevtoolsShell),
  { ssr: false },
);

const IS_DEV = process.env.NODE_ENV !== "production";

/** Append to any URL to reveal (or, `=off`, to hide) the devtools in prod. */
const URL_FLAG = "hs-devtools";
const STORE_KEY = "hs-devtools";

const OFF_VALUES = new Set(["off", "0", "false"]);

export function DevTools() {
  // Dev renders immediately. Prod stays null until opted in, so the dynamic
  // import (and the devtools bundle) never runs for a normal visitor — and the
  // null-null match between server and first client render avoids any hydration
  // mismatch before the effect below reconciles the real state.
  const [enabled, setEnabled] = useState(IS_DEV);

  useEffect(() => {
    if (IS_DEV) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const flag = params.get(URL_FLAG);

      if (flag !== null && OFF_VALUES.has(flag)) {
        window.localStorage.removeItem(STORE_KEY);
        setEnabled(false);
        return;
      }

      const hasFlag = params.has(URL_FLAG);
      if (hasFlag) window.localStorage.setItem(STORE_KEY, "1");
      if (hasFlag || window.localStorage.getItem(STORE_KEY) === "1") {
        setEnabled(true);
      }
    } catch {
      // No window / storage blocked — stay off.
    }
  }, []);

  if (!enabled) return null;
  return <DevtoolsShell />;
}
