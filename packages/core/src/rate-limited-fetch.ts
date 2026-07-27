/**
 * Rate-limited fetch: request spacing + 429 retry with backoff.
 *
 * Lives in core (not the CLI) so the engine and provider plugins can reuse it
 * without a workspace dependency cycle — both already depend on core, and core
 * depends on neither.
 */

export interface RateLimitedFetchOptions {
  /** Minimum gap between request starts. 100ms = 10 req/s. */
  minIntervalMs?: number;
  /** Max retries on 429 before giving up. */
  maxRetries?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A fetch wrapper that (a) spaces request starts `minIntervalMs` apart and
 * (b) retries 429 responses with exponential backoff (honouring Retry-After
 * when the server sends one). Non-429 responses are returned as-is — callers
 * still check `res.ok`.
 */
export function createRateLimitedFetch(
  opts: RateLimitedFetchOptions = {},
): (url: string, init?: RequestInit) => Promise<Response> {
  const minInterval = opts.minIntervalMs ?? 100;
  const maxRetries = opts.maxRetries ?? 5;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;

  let nextSlot = 0;

  const takeSlot = async () => {
    const now = Date.now();
    const wait = nextSlot - now;
    nextSlot = Math.max(nextSlot, now) + minInterval;
    if (wait > 0) await sleep(wait);
  };

  return async (url, init) => {
    for (let attempt = 0; ; attempt++) {
      await takeSlot();
      const res = await fetchImpl(url, init);
      if (res.status !== 429 || attempt >= maxRetries) {
        return res;
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoff =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1000 * 2 ** attempt, 30_000);
      await sleep(backoff);
    }
  };
}
