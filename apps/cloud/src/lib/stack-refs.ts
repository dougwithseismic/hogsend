import type { StackRefs } from "../substrate";

/**
 * Read the substrate handle back off a stack row.
 *
 * The stored jsonb is `StackRefs` PLUS the provisioning pipeline's own
 * bookkeeping (`credentialsMinted`, …), so the three seam fields are read out
 * EXPLICITLY rather than handing the whole bag to the substrate: our keys must
 * never be mistaken for the vendor's opaque `data`.
 *
 * Returns null for a stack that has not been provisioned yet, which every
 * caller has to handle anyway — a build cannot deploy onto refs that do not
 * exist.
 */
export function readStackRefs(stack: {
  substrateRefs: Record<string, unknown> | null;
}): StackRefs | null {
  const raw = stack.substrateRefs;
  if (!raw || typeof raw.substrate !== "string") return null;
  if (typeof raw.apiPublicUrl !== "string") return null;
  return {
    substrate: raw.substrate,
    apiPublicUrl: raw.apiPublicUrl,
    data: (raw.data as Record<string, unknown>) ?? {},
  };
}
