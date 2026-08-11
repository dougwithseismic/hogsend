import { generateKeyPairSync } from "node:crypto";
import type { SesRegion } from "../ses/types";

/**
 * The sending-domain vocabulary, and the DKIM keypair behind it (PRD 07).
 *
 * PURE: no database, no SES, no clock. Everything here is a value a test can
 * assert against directly, which is what makes the two facts this PRD exists
 * for provable rather than incidental:
 *
 *  - **the default flow is ONE record.** BYODKIM verifies the identity by
 *    itself, so no custom MAIL FROM is set, the return path stays a subdomain
 *    of `amazonses.com`, SPF passes natively for SES and DMARC passes on DKIM
 *    alignment. Resend asks for three records because it defaults everyone to a
 *    custom return path; shipping three would erase the entire reason this
 *    exists;
 *  - **the key is 2048-bit.** AWS accepts 1024 or 2048 and Resend signs with
 *    1024 — verified live on `resend._domainkey` at resend.com, cal.com and
 *    hogsend.com (DECISIONS §2). We sign with 2048.
 *
 * The neutral `DnsRecord` / `DomainStatus` types below MIRROR the pinned shapes
 * in `@hogsend/core` (`providers/domains.ts`) rather than importing them. The
 * control plane is a Next app that depends on no engine package for its own
 * types (the same rule the SES seam holds: every value that crosses a boundary
 * is plain and portable), and `packages/engine/src/routes/admin/domain.ts`
 * already mirrors the same shapes for the same reason. The compile-time proof
 * that the two agree lives in `packages/plugin-hogsend`, which consumes this
 * wire and types its answers as `@hogsend/core`'s `DomainStatus`.
 */

// ---------------------------------------------------------------------------
// The neutral shapes (mirror @hogsend/core providers/domains.ts)
// ---------------------------------------------------------------------------

export type DnsRecordPurpose =
  | "verification"
  | "spf"
  | "dkim"
  | "return_path"
  | "tracking"
  | "mx"
  | "other";

export type DnsRecordStatus = "pending" | "verified" | "failed" | "unknown";

export interface DnsRecord {
  type: "TXT" | "CNAME" | "MX";
  name: string;
  value: string;
  ttl?: number;
  /** MX only. */
  priority?: number;
  purpose: DnsRecordPurpose;
  status: DnsRecordStatus;
}

export type DomainVerificationState =
  | "not_found"
  | "pending"
  | "verified"
  | "failed";

export interface DomainStatus {
  domain: string;
  state: DomainVerificationState;
  records: DnsRecord[];
  providerId: string;
  /** ISO 8601 instant this status was read from SES. */
  checkedAt: string;
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The `meta.id` of the engine-side provider these statuses belong to. */
export const HOGSEND_PROVIDER_ID = "hogsend";

/**
 * The DKIM selector, so the record is `hogsend._domainkey.<domain>`.
 *
 * Legible to the customer and unambiguous against any other provider they may
 * also have configured — a domain can carry `resend._domainkey` and
 * `hogsend._domainkey` at the same time without either shadowing the other,
 * which is what makes a migration onto Hogsend Email a no-downtime change.
 */
export const HOGSEND_DKIM_SELECTOR = "hogsend";

/** 2048, where Resend signs with 1024. Asserted in tests. */
export const DKIM_KEY_BITS = 2048;

/**
 * The branded return path's subdomain. Custom MAIL FROM must be a subdomain of
 * the verified identity's own parent domain (DECISIONS §2), so customer bounces
 * CANNOT be routed through a Hogsend-owned domain and `send.<customer-domain>`
 * is the only shape on offer — exactly like Resend's.
 */
export const MAIL_FROM_SUBDOMAIN = "send";

/**
 * A single DNS label: what a customer may put in front of their own domain for
 * the branded return path (`notifications`, `mail`, `updates`).
 *
 * RFC 1035 §2.3.1 shape — starts and ends alphanumeric, hyphens allowed inside,
 * 63 characters max. Lowercased before matching because DNS is case-insensitive
 * and a customer typing `Notifications` should not be a rejection.
 *
 * It is ONE label, not a dotted path: the MAIL FROM domain must be a subdomain
 * of the verified identity's parent domain (DECISIONS §2), so anything with a
 * dot in it is either an attempt to point bounces at another domain (which SES
 * refuses) or a typo. Both are better caught here than by AWS.
 */
export const MAIL_FROM_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The caller asked for a return-path label DNS cannot represent. */
export class InvalidMailFromLabelError extends Error {
  readonly code = "invalid_mail_from_label";

  constructor(readonly label: string) {
    super(
      `"${label}" is not a valid subdomain label. Use one DNS label: lowercase ` +
        "letters, digits and hyphens, starting and ending alphanumeric, 63 " +
        'characters or fewer (e.g. "notifications"). No dots — the return path ' +
        "must sit directly under the domain you verified.",
    );
    this.name = "InvalidMailFromLabelError";
  }
}

/**
 * Normalize and validate a return-path label, or throw.
 *
 * Throws rather than falling back to `send`, and that is deliberate: silently
 * substituting a default for a label the customer typed would publish records
 * for a domain they did not ask for, and they would find out by checking DNS
 * for a name that is not there.
 */
export function assertMailFromLabel(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (!MAIL_FROM_LABEL_PATTERN.test(normalized)) {
    throw new InvalidMailFromLabelError(label);
  }
  return normalized;
}

/** SES's own SPF include. The record a branded return path needs. */
export const MAIL_FROM_SPF_VALUE = "v=spf1 include:amazonses.com ~all";

/** SES publishes one feedback host per region; priority 10 is its documented value. */
export const MAIL_FROM_MX_PRIORITY = 10;

/**
 * Pinned domain shape, byte-identical to the engine admin route's `DOMAIN_RE`.
 * A domain that would be refused there must be refused here too, or the CLI
 * would accept a name the control plane then answers 400 for.
 */
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Lowercase, trimmed, trailing dot removed — or `null` when it is not a domain.
 *
 * `null` rather than a throw because the caller (the route) turns it into a 400
 * with a sentence, and a thrown string would have to be re-parsed to do that.
 */
export function normalizeDomain(domain: string): string | null {
  const trimmed = domain.trim().toLowerCase().replace(/\.+$/, "");
  return DOMAIN_RE.test(trimmed) ? trimmed : null;
}

/**
 * The DKIM host, FULLY QUALIFIED.
 *
 * Fully qualified rather than relative (`hogsend._domainkey`) because that is
 * what the customer pastes and what a `dig` reproduces — the same choice
 * `plugin-postmark` already makes with Postmark's `DKIMHost`. Cloudflare's API
 * accepts either; the CLI's `dns-apply` passes `name` through verbatim.
 */
export function dkimRecordHost(domain: string): string {
  return `${HOGSEND_DKIM_SELECTOR}._domainkey.${domain}`;
}

/**
 * `<label>.<domain>` — the branded return path, when it is switched on.
 *
 * The label defaults to `send`, so a customer who never chose one gets records
 * BYTE-IDENTICAL to what this emitted before the label existed. That is not a
 * nicety: anyone already onboarded has published `send.<their-domain>` in their
 * own DNS, and a changed default would silently invalidate it.
 */
export function mailFromDomainFor(domain: string, label?: string): string {
  const sub =
    label === undefined ? MAIL_FROM_SUBDOMAIN : assertMailFromLabel(label);
  return `${sub}.${domain}`;
}

/** SES's bounce/complaint feedback host for the region the tenant is pinned to. */
export function feedbackSmtpHost(awsRegion: SesRegion): string {
  return `feedback-smtp.${awsRegion}.amazonses.com`;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * THE record. One TXT carrying the public half of our own key.
 *
 * The value is `p=<publicKey>`, which is what AWS's BYODKIM instructions
 * publish. RFC 6376 makes `v=` RECOMMENDED with a default of `DKIM1` and `k=`
 * default `rsa`, so the bare `p=` tag is a complete key record.
 */
export function dkimRecord(
  domain: string,
  publicKey: string,
  status: DnsRecordStatus,
): DnsRecord {
  return {
    type: "TXT",
    name: dkimRecordHost(domain),
    value: `p=${publicKey}`,
    purpose: "dkim",
    status,
  };
}

/**
 * The two records a branded return path adds, and NEVER more.
 *
 * Built from the MAIL FROM domain SES actually reports rather than from
 * `send.<domain>`, so an identity somebody pointed elsewhere out of band still
 * renders the records that would make it work rather than a plausible fiction.
 */
export function mailFromRecords(input: {
  mailFromDomain: string;
  awsRegion: SesRegion;
  status: DnsRecordStatus;
}): DnsRecord[] {
  return [
    {
      type: "MX",
      name: input.mailFromDomain,
      value: feedbackSmtpHost(input.awsRegion),
      priority: MAIL_FROM_MX_PRIORITY,
      purpose: "mx",
      status: input.status,
    },
    {
      type: "TXT",
      name: input.mailFromDomain,
      value: MAIL_FROM_SPF_VALUE,
      purpose: "spf",
      status: input.status,
    },
  ];
}

// ---------------------------------------------------------------------------
// The keypair
// ---------------------------------------------------------------------------

export interface DkimKeypair {
  selector: string;
  /** Base64 PKCS#8 DER, single line. The format `CreateEmailIdentity` takes. */
  privateKey: string;
  /** Base64 SPKI DER, single line. The half that goes into the TXT record. */
  publicKey: string;
}

/**
 * A fresh 2048-bit RSA keypair, in the exact single-line base64 both SES and a
 * DKIM TXT record want.
 *
 * DER + base64 rather than PEM-then-strip: the stripping version has to remove
 * a header, a footer and every newline, and the failure mode of getting it
 * subtly wrong (a stray `\n`) is an identity SES accepts and then never
 * verifies. Asking Node for DER skips the round trip entirely.
 *
 * The private half is a SECRET and leaves this function exactly twice: into the
 * encrypted `provider_keys` payload, and into `CreateEmailIdentity`'s signing
 * attributes. It is never logged, never returned by an API, never audited.
 */
export function generateDkimKeypair(): DkimKeypair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: DKIM_KEY_BITS,
    privateKeyEncoding: { type: "pkcs8", format: "der" },
    publicKeyEncoding: { type: "spki", format: "der" },
  });
  return {
    selector: HOGSEND_DKIM_SELECTOR,
    privateKey: privateKey.toString("base64"),
    publicKey: publicKey.toString("base64"),
  };
}
