/**
 * `HogsendContext` holds `{ client }` — a STABLE reference that never changes
 * across renders. No reactive data flows through context; everything goes
 * through `useSyncExternalStore` selector subscriptions, so no consumer
 * re-renders from context value churn.
 */

import type { ColorMode, Hogsend } from "@hogsend/js";
import { createContext } from "react";

/** Color-mode controls the provider exposes via context (stable callbacks). */
export interface ColorModeControls {
  colorMode: ColorMode;
  setColorMode: (mode: ColorMode | "system") => void;
}

/** The context value — a stable object, by design. */
export interface HogsendContextValue {
  client: Hogsend;
  color: ColorModeControls;
}

export const HogsendContext = createContext<HogsendContextValue | null>(null);
