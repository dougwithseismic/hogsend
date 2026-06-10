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
}
