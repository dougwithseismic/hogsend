"use client";

import { useFlag } from "@hogsend/react";

/**
 * Live dogfood of native feature flags on the docs site. This strip renders
 * ONLY when the `docs-preview-banner` flag evaluates true for the visitor — the
 * browser SDK fetches `GET /v1/flags`, writes the reactive slice, and
 * `useFlag` selects the value. Toggle the flag in Studio and the strip appears
 * or disappears on the next evaluation, with no redeploy.
 *
 * MUST be mounted inside `<HogsendProvider>` (useFlag throws otherwise), so the
 * caller gates it on `isHogsendConfigured` — the same condition that mounts the
 * provider.
 */
export function FlagPreviewBanner() {
  const on = useFlag("docs-preview-banner");
  if (on !== true) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-2 bg-[#f64838] px-4 py-2 text-center font-medium text-sm text-white">
      🚩 Docs preview is live — gated by the{" "}
      <code className="rounded bg-white/20 px-1 font-mono">
        docs-preview-banner
      </code>{" "}
      Hogsend feature flag
    </div>
  );
}
