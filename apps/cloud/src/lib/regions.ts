import { eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { cells } from "../db/schema";
import type { CloudRegion } from "../services/orgs";

/**
 * What the region picker may offer.
 *
 * Placement is a rule, not a preference (`OrgService.create`): a shared-tier
 * org must land on an accepting cell in its own region. Offering a region with
 * no accepting cell would be a control that only ever produces an error, so the
 * form asks the database which regions can actually take a tenant.
 *
 * This is deliberately NOT a capacity check. A cell that is accepting but full
 * still fails at placement, and re-counting tenants here would be a second,
 * racier copy of the placer's own locked count — the typed `illegal_region`
 * error on submit is the honest answer to that case.
 */

export type RegionOption = {
  id: CloudRegion;
  label: string;
  /** One factual line: where the data physically sits. */
  detail: string;
};

/** Every region the control plane knows, in display order. */
export const CLOUD_REGIONS: readonly RegionOption[] = [
  {
    id: "us",
    label: "United States",
    detail: "Data stays in US infrastructure.",
  },
  {
    id: "eu",
    label: "European Union",
    detail: "Data stays in EU infrastructure.",
  },
] as const;

/** Regions with at least one accepting cell — the shared-tier offer. */
export async function listAcceptingRegions(
  db: CloudDb = defaultDb,
): Promise<CloudRegion[]> {
  const rows = await db
    .selectDistinct({ region: cells.region })
    .from(cells)
    .where(eq(cells.accepting, true));

  const accepting = new Set(rows.map((row) => row.region));
  return CLOUD_REGIONS.filter((region) => accepting.has(region.id)).map(
    (region) => region.id,
  );
}
