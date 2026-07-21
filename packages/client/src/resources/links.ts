import type { HttpClient } from "../internal/http.js";
import type {
  CreatedLink,
  CreateLinkInput,
  Link,
  LinkDetail,
  LinkList,
  LinkQrOptions,
  LinkType,
  UpdateLinkInput,
} from "../types.js";

const BASE = "/v1/admin/links";

/**
 * The `links.*` resource — mint and manage tracked short links (vanity slugs,
 * QR codes, per-destination stats, arrival attribution).
 *
 * IMPORTANT: unlike the ingest-key data-plane resources, this resource targets
 * the ADMIN plane (`/v1/admin/links`) and REQUIRES a full-admin `apiKey`.
 *
 * Standalone-QR recipe (a printed code that can be re-pointed later):
 *
 * ```ts
 * const link = await hs.links.create({
 *   url: "https://example.com/launch",
 *   idempotencyKey: "print-run-2026-07", // safe to re-run — same link back
 * });
 * const png = await hs.links.qr(link.id, { format: "png", size: 1024 });
 * // ...print it. Later, re-point the SAME printed code:
 * await hs.links.update(link.id, { originalUrl: "https://example.com/v2" });
 * ```
 */
export class LinksResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Mint a managed tracked link. `source` defaults to `"api"` (honest SDK
   * provenance). `idempotencyKey` makes the mint safe to re-run: the same
   * key + url returns the existing link with `existing: true`; a slug or key
   * taken by a different destination rejects with a 409
   * {@link HogsendAPIError}. NOTE: the key travels in the request BODY (the
   * admin route reads it there), never as an `Idempotency-Key` header.
   */
  create(input: CreateLinkInput): Promise<CreatedLink> {
    return this.http.post<CreatedLink>(BASE, {
      url: input.url,
      type: input.type,
      slug: input.slug,
      label: input.label,
      description: input.description,
      appendRef: input.appendRef,
      campaign: input.campaign,
      distinctId: input.distinctId,
      source: input.source ?? "api",
      idempotencyKey: input.idempotencyKey,
    });
  }

  /** Fetch one link with recent clicks + per-destination stats (404 throws). */
  get(id: string): Promise<LinkDetail> {
    return this.http.get<LinkDetail>(`${BASE}/${encodeURIComponent(id)}`);
  }

  /**
   * List managed links (newest first). Returns the full
   * `{ links, total, limit, offset }` envelope. `includeArchived` is sent
   * ONLY when `true` — the engine coerces the STRING `"false"` to true, so
   * false must be expressed by omission.
   */
  list(opts?: {
    limit?: number;
    offset?: number;
    type?: LinkType;
    includeArchived?: boolean;
    hasQr?: boolean;
  }): Promise<LinkList> {
    return this.http.get<LinkList>(BASE, {
      limit: opts?.limit,
      offset: opts?.offset,
      type: opts?.type,
      includeArchived: opts?.includeArchived === true ? "true" : undefined,
      hasQr: opts?.hasQr === undefined ? undefined : String(opts.hasQr),
    });
  }

  /**
   * Patch a link. Only provided fields change; `null` clears a nullable field
   * (e.g. `slug: null`). Re-pointing `originalUrl` keeps every printed or
   * shared code working — it re-targets the redirect row too.
   */
  update(id: string, input: UpdateLinkInput): Promise<Link> {
    return this.http.patch<Link>(`${BASE}/${encodeURIComponent(id)}`, {
      originalUrl: input.originalUrl,
      slug: input.slug,
      label: input.label,
      description: input.description,
      appendRef: input.appendRef,
      campaign: input.campaign,
    });
  }

  /** Archive a link (soft-delete). Returns the archived flat link. */
  archive(id: string): Promise<Link> {
    return this.http.del<Link>(`${BASE}/${encodeURIComponent(id)}`);
  }

  /**
   * Fetch the link's QR code. Dispatches on the RESPONSE Content-Type:
   * `image/svg+xml` → the SVG markup as a string; anything else (PNG) → the
   * raw image bytes as a `Uint8Array`. The engine defaults to SVG when
   * `format` is omitted, so the formatless call returns a string; pass
   * `format: "png"` for bytes.
   */
  qr(id: string, opts: LinkQrOptions & { format: "png" }): Promise<Uint8Array>;
  qr(id: string, opts?: LinkQrOptions & { format?: "svg" }): Promise<string>;
  qr(id: string, opts?: LinkQrOptions): Promise<string | Uint8Array>;
  async qr(id: string, opts?: LinkQrOptions): Promise<string | Uint8Array> {
    const { bytes, contentType } = await this.http.getRaw(
      `${BASE}/${encodeURIComponent(id)}/qr`,
      {
        format: opts?.format,
        size: opts?.size,
        transparent: opts?.transparent ? "true" : undefined,
      },
    );
    return contentType?.includes("svg")
      ? new TextDecoder().decode(bytes)
      : bytes;
  }

  /**
   * Build the QR endpoint URL for a link — NO network call. Returns a PLAIN
   * URL with no auth material: the endpoint is admin-guarded, so the caller
   * must attach the admin Bearer token (or an admin session) themselves.
   * NEVER embed the apiKey in this URL (e.g. as a query param) — it would
   * leak through logs, referrers, and shared markup.
   */
  qrUrl(id: string, opts?: LinkQrOptions): string {
    return this.http.resolveUrl(`${BASE}/${encodeURIComponent(id)}/qr`, {
      format: opts?.format,
      size: opts?.size,
      transparent: opts?.transparent ? "true" : undefined,
    });
  }
}
