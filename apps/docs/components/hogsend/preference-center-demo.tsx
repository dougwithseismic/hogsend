"use client";

import { PreferenceCenter } from "@hogsend/react/preferences";
import { Card } from "@/components/ds/card";
import { isHogsendConfigured } from "./config";

/**
 * Live `<PreferenceCenter>` read of the dogfood engine's list catalog.
 *
 * `PreferenceCenter` reads `usePreferences()` → `GET /v1/lists` (reachable with
 * an anonymous `pk_` key) and renders one row per code-defined list at its
 * `defaultOptIn` state. As an anonymous visitor the toggles don't persist — the
 * engine requires an identified user with a `userToken` to write list prefs —
 * so a flip reverts on the next refetch.
 *
 * Gated on `isHogsendConfigured` so the docs build (no engine wired) renders
 * nothing; the wrapper is required because `PreferenceCenter` throws without a
 * `<HogsendProvider>` ancestor, and the docs provider is pass-through when
 * unconfigured.
 */
export function PreferenceCenterDemo() {
  if (!isHogsendConfigured) return null;
  return (
    <Card className="my-8 p-6 not-prose">
      <PreferenceCenter title="Email preferences" />
    </Card>
  );
}
