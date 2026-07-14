"use client";

import { useEffect } from "react";
import { POSTPHANT_ASCII } from "@/lib/postphant-ascii";

// Module-level flag: client-side navigations remount the tree but never
// reload the module, so the greeting logs exactly once per page load.
let logged = false;

/** One-time console greeting — Postphant, for whoever opens devtools. */
export function ConsoleEgg() {
  useEffect(() => {
    if (logged) return;
    logged = true;
    // Single-argument log: no format-specifier substitution happens, so the
    // art's `%` characters render verbatim.
    console.log(`${POSTPHANT_ASCII}\n\n   hello@hogsend.com\n`);
  }, []);
  return null;
}
