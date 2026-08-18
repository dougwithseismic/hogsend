import type { HttpClient } from "../internal/http.js";
import type {
  ImportReferralTouchesInput,
  ImportReferralTouchesResult,
  ReferralReport,
  ReferralReportInput,
  ReferralTouchInput,
  ReferralTouchResult,
  ReferralTree,
  ReferralTreeInput,
} from "../types.js";

const BASE = "/v1/referrals";

/**
 * The `referrals.*` resource: the SECRET-KEY-ONLY referral plane
 * (`/v1/referrals`), which needs the orthogonal `referrals` scope on the key.
 *
 * Four calls, two of which look alike and are deliberately not the same thing:
 *
 * - {@link ReferralsResource.touch} goes through the intent layer, so a fresh
 *   edge emits `referral.touched` (and `referral.bound`) and reward journeys
 *   fire. That is what an invite, a typed code or an operator correction is.
 * - {@link ReferralsResource.import} is insert-only and SILENT: backfilling a
 *   year of history must not send a year of reward emails.
 *
 * `report` and `tree` are pure reads. Model, window, depth and weights are
 * request parameters, so changing your mind costs nothing and backfills
 * nothing.
 *
 * There is no `link()` here: the caller's own share link is browser-side
 * (`hogsend.referral.link()` in `@hogsend/js`, gated on a server-minted
 * `userToken`), and the engine exposes no secret-key mint route.
 */
export class ReferralsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Record a referral touch through the INTENT layer. Name the referrer by
   * `referrerContactId`, `referrerKey` or the `slug` of their shared link (the
   * slug also selects the referral). A referee that resolves to a contact
   * binds the edge immediately; a bare `refereeKey` records the cold edge.
   *
   * Emits on a fresh write only. A repeat of the same pair returns the
   * existing edge with `created: false` and emits nothing.
   */
  touch(input: ReferralTouchInput): Promise<ReferralTouchResult> {
    return this.http.post<ReferralTouchResult>(`${BASE}/touch`, {
      referral: input.referral,
      referrerContactId: input.referrerContactId,
      referrerKey: input.referrerKey,
      slug: input.slug,
      refereeContactId: input.refereeContactId,
      refereeKey: input.refereeKey,
      source: input.source,
      properties: input.properties,
      idempotencyKey: input.idempotencyKey,
    });
  }

  /**
   * The referral revenue report. Picks each referee's effective edge(s) under
   * `model` within `window`, walks the referrer chain to `depth`, and credits
   * `weights[level] * edgeWeight * conversion value`.
   *
   * VALUES ARE NEVER CONVERTED BETWEEN CURRENCIES: every monetary field is a
   * list of `{ currency, value }`. Page with `limit` + the opaque `cursor`
   * echoed back as `nextCursor`.
   */
  report(input: ReferralReportInput = {}): Promise<ReferralReport> {
    return this.http.get<ReferralReport>(`${BASE}/report`, {
      referral: input.referral,
      model: input.model,
      window: input.window,
      depth: input.depth,
      weights: input.weights?.join(","),
      from: toIso(input.from),
      to: toIso(input.to),
      limit: input.limit,
      cursor: input.cursor,
    });
  }

  /**
   * One referrer's descendants, `depth` levels down (default 3, cap 5), over
   * every non-rejected edge. A ledger view, not a model: no window, no
   * weights, and the per-node conversion totals count every conversion.
   *
   * `contactId` may be a uuid or an external key. An unknown key is an empty
   * `nodes` list, not a 404, because "referred nobody" is the same answer.
   */
  tree(
    contactId: string,
    input: ReferralTreeInput = {},
  ): Promise<ReferralTree> {
    return this.http.get<ReferralTree>(
      `${BASE}/tree/${encodeURIComponent(contactId)}`,
      { referral: input.referral, depth: input.depth },
    );
  }

  /**
   * Import historical touches. INSERT-ONLY and SILENT: every row is written
   * with `source: "import"` at its own `touchedAt` and NOTHING is emitted (no
   * `referral.*` event, no journey). An existing edge is counted as `existing`
   * and left untouched; a row whose referrer or referee cannot be resolved is
   * counted as `skipped`. Max 1000 rows per call.
   */
  import(
    input: ImportReferralTouchesInput,
  ): Promise<ImportReferralTouchesResult> {
    return this.http.post<ImportReferralTouchesResult>(`${BASE}/import`, {
      referral: input.referral,
      touches: input.touches.map((row) => ({
        referrerContactId: row.referrerContactId,
        referrerKey: row.referrerKey,
        refereeContactId: row.refereeContactId,
        refereeKey: row.refereeKey,
        touchedAt: toIso(row.touchedAt) ?? "",
        properties: row.properties,
        idempotencyKey: row.idempotencyKey,
      })),
    });
  }
}

/** `Date | string | undefined` -> the ISO string the routes parse. */
function toIso(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}
