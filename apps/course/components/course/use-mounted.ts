"use client";

import { useEffect, useState } from "react";

/**
 * True only after the first client render. Session-dependent affordances in
 * the interactive blocks render behind this gate: better-auth's useSession can
 * resolve BEFORE React hydrates, so branching on it during hydration makes the
 * client's first render disagree with the SSR HTML (hydration mismatch).
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
