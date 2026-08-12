// ---------------------------------------------------------------------------
// Provider-neutral sending-domain contract (the OPTIONAL `domains` capability)
// ---------------------------------------------------------------------------

/**
 * What a DNS record is FOR, provider-neutrally. Each provider's domains
 * implementation maps its own labels onto this union (Resend: SPF/DKIM record
 * kinds; Postmark: DKIM + Return-Path). `other` is the conservative fallback
 * for anything a provider invents that has no neutral name yet.
 */
export type DnsRecordPurpose =
  | "verification"
  | "spf"
  | "dkim"
  | "return_path"
  | "tracking"
  | "mx"
  | "other";

/**
 * Per-record verification status as the PROVIDER reports it. `unknown` is for
 * providers that don't report per-record status at all — the overall
 * {@link DomainStatus.state} remains the authoritative signal.
 */
export type DnsRecordStatus = "pending" | "verified" | "failed" | "unknown";

/**
 * One DNS record the operator must add at their DNS host. This is the neutral
 * shape every surface renders (admin route, `hogsend domain`, Studio Setup) and
 * the CLI auto-apply (`dns-apply.ts`) writes via the Cloudflare/Vercel APIs.
 */
export interface DnsRecord {
  type: "TXT" | "CNAME" | "MX";
  /** Host as the provider reports it (may be relative, e.g. "resend._domainkey"). */
  name: string;
  value: string;
  ttl?: number;
  /** MX only. */
  priority?: number;
  purpose: DnsRecordPurpose;
  status: DnsRecordStatus;
}

/**
 * Overall domain verification state. `not_found` means the provider does not
 * know the domain (it was never created there); the engine also reports it
 * when the capability is supported but the domain hasn't been added yet.
 */
export type DomainVerificationState =
  | "not_found"
  | "pending"
  | "verified"
  | "failed";

/**
 * The provider-neutral snapshot of one sending domain: its overall state plus
 * the DNS records required to verify it. Returned by every
 * {@link DomainsCapability} method that resolves a domain.
 */
export interface DomainStatus {
  domain: string;
  state: DomainVerificationState;
  records: DnsRecord[];
  /** {@link EmailProviderMeta.id} of the provider that produced this status. */
  providerId: string;
  /** ISO 8601 instant this status was fetched from the provider. */
  checkedAt: string;
  /** The untouched provider payload, for debugging / escape hatch. */
  raw?: unknown;
}

/**
 * A single DNS label for the branded return path's subdomain (`send`,
 * `notifications`, `mail`). RFC 1035 §2.3.1 shape: starts and ends
 * alphanumeric, hyphens allowed inside, 63 characters max. ONE label, no dots
 * — the return path must sit directly under the verified domain.
 *
 * BYTE-IDENTICAL to the control plane's `MAIL_FROM_LABEL_PATTERN`
 * (apps/cloud `lib/sending-domains.ts`), which stays authoritative on its side
 * of the wire: a label accepted here must be one the control plane can
 * publish, or the engine would 200 a request the relay then 400s.
 */
export const RETURN_PATH_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Trim + lowercase (DNS is case-insensitive, so a customer typing
 * `Notifications` is not wrong), then validate against
 * {@link RETURN_PATH_LABEL_PATTERN}. Answers `null` rather than throwing so a
 * caller can name the offending input in its own rejection instead of parsing
 * a thrown message.
 */
export function normalizeReturnPathLabel(label: string): string | null {
  const normalized = label.trim().toLowerCase();
  return RETURN_PATH_LABEL_PATTERN.test(normalized) ? normalized : null;
}

/** Input to {@link DomainsCapability.setReturnPath} — both directions. */
export interface SetReturnPathInput {
  domain: string;
  /** `false` reverts to the provider's own default return path. */
  enabled: boolean;
  /**
   * Single DNS label in front of the domain (`notifications` →
   * `notifications.<domain>`). Optional; the provider's default (`send`)
   * applies when omitted. Meaningful only when enabling.
   */
  label?: string;
}

/**
 * What a return-path switch answers, in both directions. `enabled` and
 * `mailFromDomain` are what the provider holds AFTER the write — read back,
 * never an echo of the request.
 */
export interface ReturnPathState {
  enabled: boolean;
  /**
   * `<label>.<domain>` when enabled; `null` when the provider's default
   * return path is in effect.
   */
  mailFromDomain: string | null;
  /**
   * Fresh status. When enabled it carries the two extra records (MX + SPF) as
   * `pending` until published; when disabled they stop being reported and the
   * domain stays fully verified on its base records — off is not a warning
   * state.
   */
  status: DomainStatus;
}

/**
 * Optional provider capability for managing sending domains. PRESENCE IS THE
 * GATE: a provider that cannot manage domains simply omits the member, and the
 * engine/CLI/Studio degrade gracefully (admin POSTs return 501
 * `provider_unsupported`, `EngineDomainStatus.supported` is `false`).
 *
 * Like the send wire, this is a DUMB translation layer: plain HTTP against the
 * provider's domains API, normalized into {@link DomainStatus}/{@link DnsRecord}.
 * Caching, env derivation, and test-mode policy all live in the engine's
 * `DomainStatusService` — never here.
 */
export interface DomainsCapability {
  /**
   * Register the domain with the provider. IDEMPOTENT: when the domain already
   * exists there, implementations fall through to a lookup and return the
   * existing status rather than throwing.
   */
  create(domain: string): Promise<DomainStatus>;
  /** Current status, or `null` when the provider doesn't know the domain. */
  get(domain: string): Promise<DomainStatus | null>;
  /** The DNS records required to verify the domain. */
  records(domain: string): Promise<DnsRecord[]>;
  /**
   * Trigger a provider-side verification pass where supported (e.g. Resend's
   * `POST /domains/:id/verify`). Providers without an explicit verify endpoint
   * omit this; callers fall back to `get`.
   */
  verify?(domain: string): Promise<DomainStatus>;
  /**
   * Switch the branded return path (custom MAIL FROM domain) on or off. A
   * standard ESP concept, so it is first-class here — and OPTIONAL like
   * `verify`: a provider that cannot do it omits the member and the engine
   * answers 501 exactly as when `domains` itself is absent.
   *
   * What it buys: bounce traffic routes via `<label>.<domain>` instead of the
   * provider's own domain, so mailbox UIs stop showing "via <provider>" under
   * the sender name and SPF aligns with the customer's domain. It changes
   * NOTHING about where incoming mail lands — that routes on the `From`
   * headers and works with no return path configured. Off is the default, and
   * a domain without the upgrade is fully verified on its base records.
   */
  setReturnPath?(input: SetReturnPathInput): Promise<ReturnPathState>;
}
