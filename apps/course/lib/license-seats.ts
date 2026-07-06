/**
 * Pure seat-count rules for team licences — no server deps, so the checkout
 * route, the webhook, the purchase UI, and unit tests all share one clamp.
 */

export const MIN_TEAM_SEATS = 2;
export const MAX_TEAM_SEATS = 25;

/** Parse + clamp a seats form value into the allowed range. */
export function clampSeats(raw: unknown): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return MIN_TEAM_SEATS;
  return Math.min(MAX_TEAM_SEATS, Math.max(MIN_TEAM_SEATS, n));
}
