/**
 * Banner client — v3. Module exists in v1 so the subpath export, types, and the
 * `Hogsend.banners()` signature are stable now; impl lands in v3. SIGNATURES
 * complete; bodies throw a clear "not implemented in v1" Error.
 */

/** A single on-site banner. */
export interface Banner {
  id: string;
  slot: string;
  title: string | null;
  body: string | null;
  actionUrl: string | null;
  metadata: Record<string, unknown> | null;
  dismissed: boolean;
}

/** The banner sub-client. */
export interface BannerClient {
  /** Eligible banners for the slot. */
  list(): Promise<Banner[]>;
  /** Highest-priority eligible banner, else null. */
  current(): Promise<Banner | null>;
  /** Record a click (`banner.clicked`). */
  click(bannerId: string): Promise<void>;
  /** Dismiss a banner (`banner.dismissed`). */
  dismiss(bannerId: string): Promise<void>;
}

const NOT_IMPLEMENTED =
  "@hogsend/js: banners are not implemented in v1 (lands in v3)";

/** v3 factory placeholder. Throws until v3 wires banners. */
export function createBannerClient(_slot: string): BannerClient {
  throw new Error(NOT_IMPLEMENTED);
}
