/**
 * Deterministic in-process `fetch` for the account-link test suites.
 *
 * The injection point is PRD 01's `HandleCallbackArgs.fetchImpl` (resolved as
 * `fetchImpl ?? globalThis.fetch` inside the presets) — the same pattern
 * `plugin-apollo` proved (`packages/plugin-apollo/src/index.ts:46-47`, "the
 * whole suite runs offline through this"). The engine providers therefore need
 * no `fetch` field of their own, and PRD 07's route tests thread the same
 * `fetchImpl` through.
 *
 * Routes key on `method + " " + url-without-query`, so a test asserts query
 * params off `calls` rather than baking them into the key. An unmatched call
 * THROWS with the full URL, so a provider that quietly reaches an unexpected
 * endpoint fails loudly instead of hanging on a real network call.
 */

export interface FakeFetchRoute {
  /** Response status. Default 200. */
  status?: number;
  /** JSON body — serialized with `JSON.stringify`, `content-type: application/json`. */
  body?: unknown;
  /**
   * Plain-text body (`content-type: text/plain`) — Steam's
   * `check_authentication` answers key-value text, not JSON. Wins over `body`
   * when both are set.
   */
  text?: string;
}

export interface FakeFetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function normalizeHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  // Headers lower-cases names on iteration; mirror that for the other shapes
  // so a test never has to guess the casing.
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key.toLowerCase()] = value;
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

export function fakeFetch(routes: Record<string, FakeFetchRoute>): {
  fetchImpl: typeof fetch;
  calls: FakeFetchCall[];
} {
  const calls: FakeFetchCall[] = [];

  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const parsed = new URL(url);
    const key = `${method} ${parsed.origin}${parsed.pathname}`;

    const rawBody = init?.body;
    calls.push({
      url,
      method,
      headers: normalizeHeaders(init?.headers),
      body: rawBody === undefined || rawBody === null ? null : String(rawBody),
    });

    const route = routes[key];
    if (!route) {
      throw new Error(
        `fakeFetch: no route registered for "${key}" (full url: ${url}). ` +
          `Registered: ${Object.keys(routes).join(", ") || "<none>"}`,
      );
    }

    const status = route.status ?? 200;
    const isText = route.text !== undefined;
    const bodyText = isText
      ? (route.text as string)
      : route.body !== undefined
        ? JSON.stringify(route.body)
        : "";
    return new Response(bodyText, {
      status,
      headers: {
        "content-type": isText
          ? "text/plain; charset=utf-8"
          : "application/json",
      },
    });
  }) as typeof fetch;

  return { fetchImpl, calls };
}
