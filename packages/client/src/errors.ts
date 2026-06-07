/**
 * A non-2xx response — or a transport-level failure — from the Hogsend data
 * plane. `status` is the HTTP status code, or `0` when the request never
 * reached the server (DNS/connect/timeout). `body` is the parsed JSON body when
 * available, else the raw text, else `undefined`.
 */
export class HogsendAPIError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "HogsendAPIError";
    this.status = status;
    this.body = body;
    // Restore prototype chain for instanceof across transpile targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A `429 Too Many Requests` response. `retryAfter` is the parsed `Retry-After`
 * header in seconds when present (the server sends it on 429 for `/v1/emails`).
 */
export class RateLimitError extends HogsendAPIError {
  readonly retryAfter?: number;

  constructor(message: string, body: unknown, retryAfter?: number) {
    super(message, 429, body);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
