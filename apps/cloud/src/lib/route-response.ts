/**
 * The refusal envelope every CLI-facing route answers with.
 *
 * `{ error, message }` — a machine-readable slug the CLI branches on, and a
 * sentence a human reads — plus `cache-control: no-store` on EVERY refusal,
 * because these routes deal in codes, sessions and tokens and none of it may
 * sit in an intermediary's cache.
 *
 * It lives here rather than in each route because four routes had a
 * byte-identical copy, and the failure that invites is subtle: one of them
 * quietly loses the no-store header, and nothing fails until a proxy serves a
 * stale refusal to somebody whose code has since been accepted.
 */
export function fail(
  status: number,
  error: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error, message },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );
}
