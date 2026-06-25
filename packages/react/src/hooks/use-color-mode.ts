"use client";

/**
 * Color-mode helpers + the `useColorMode()` hook. `system` reads
 * `prefers-color-scheme`; only color tokens flip (scalars are mode-independent,
 * §6). All DOM access is guarded so SSR never throws.
 */

import type { ColorMode } from "@hogsend/js";
import { useContext } from "react";
import { HogsendContext } from "../provider/context.js";

/** Resolve the system color mode, defaulting to "light" when undeterminable. */
export function resolveSystemColorMode(): ColorMode {
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

/**
 * Subscribe to system color-mode changes. Returns an unsubscribe fn (no-op
 * outside the browser).
 */
export function watchSystemColorMode(
  onChange: (mode: ColorMode) => void,
): () => void {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return () => {};
  }
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = (event: MediaQueryListEvent): void => {
    onChange(event.matches ? "dark" : "light");
  };
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

/** Read the active color mode + setter from the provider. */
export function useColorMode(): {
  colorMode: ColorMode;
  setColorMode: (mode: ColorMode | "system") => void;
} {
  const ctx = useContext(HogsendContext);
  if (!ctx) {
    throw new Error("useColorMode must be used within <HogsendProvider>");
  }
  return ctx.color;
}
