import { eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments } from "../db/schema";
import type {
  DkimKeypair,
  DnsRecord,
  DnsRecordStatus,
  DomainStatus,
  DomainVerificationState,
} from "../lib/sending-domains";
import {
  dkimRecord,
  generateDkimKeypair,
  HOGSEND_PROVIDER_ID,
  mailFromDomainFor,
  mailFromRecords,
  normalizeDomain,
} from "../lib/sending-domains";
import type { SesClient } from "../ses/contract";
import { getSesClient } from "../ses/index";
import type {
  SesDkimStatus,
  SesIdentity,
  SesMailFromStatus,
  SesRegion,
} from "../ses/types";
import { SesError } from "../ses/types";
import type { SubstrateRegion } from "../substrate/types";
import { writeAudit } from "./audit";
import { CloudServiceError, NotFoundError } from "./errors";
import { readDkimKey, writeDkimKey } from "./ses-dkim-keys";
import { getSesTenant } from "./ses-tenants";

/**
 * The sending-domain capability (PRD 07), implemented against the SES seam.
 *
 * The competitive point, and the regression this file exists to prevent:
 * **the default flow returns EXACTLY ONE DNS record.** One TXT at
 * `hogsend._domainkey.<domain>` carrying the public half of a 2048-bit key we
 * generated. BYODKIM verifies the identity by itself, so no custom MAIL FROM is
 * set, the return path stays a subdomain of `amazonses.com`, SPF passes
 * natively for SES and DMARC passes on DKIM alignment. Resend asks for three
 * records because it defaults everyone to a custom return path — shipping three
 * would erase the whole reason this exists, which is why the tests assert the
 * COUNT rather than merely that the right record is present.
 *
 * The other decisions worth not re-deriving:
 *
 *  - **`create` never mints a second keypair.** An existing identity falls
 *    through to a lookup, and a stored key is reused even when SES has lost the
 *    identity. A second keypair would invalidate the record the customer has
 *    already published, and they would have no way of knowing why their mail
 *    stopped signing.
 *  - **The branded return path is OFF by default and reversible.** On, it adds
 *    exactly two records (MX + SPF at `send.<domain>`); off, they are gone
 *    again and the identity is back on SES's default return path.
 *  - **`USE_DEFAULT_VALUE`, never `REJECT_MESSAGE`.** If a customer's MX breaks
 *    six months after they set it up, their mail keeps flowing on the default
 *    return path. Choosing reject would convert a DNS mistake into an outage.
 *    (`USE_DEFAULT_VALUE` is SESv2's spelling of what PRD 07 calls
 *    `USE_DEFAULT_MAIL_FROM`; the seam pins AWS's literal.)
 *  - **Nothing here throws for an absent domain.** `get` answers `null`,
 *    `records` answers `[]`, `verify` answers a `not_found` status. A domain
 *    the operator has not added yet is an ordinary state of the world, not an
 *    error a UI has to catch.
 */

/** The capability, plus the branded-return-path toggle the interface has no room for. */
export interface HogsendDomains {
  /** Register the domain. Idempotent: an existing one falls through to a lookup. */
  create(domain: string): Promise<DomainStatus>;
  /** Current status, or `null` when SES does not know the domain. */
  get(domain: string): Promise<DomainStatus | null>;
  /** The DNS records required to verify the domain. `[]` when unknown. */
  records(domain: string): Promise<DnsRecord[]>;
  /** Re-read the status. `state: "not_found"` when the domain was never created. */
  verify(domain: string): Promise<DomainStatus>;
  /** Turn the branded return path on or off. Both directions revert cleanly. */
  setReturnPath(input: {
    domain: string;
    enabled: boolean;
    /**
     * The subdomain the return path sits on, e.g. `notifications` for
     * `notifications.acme.com`. Defaults to `send`, so an existing customer
     * who never chose one keeps the records they already published.
     */
    label?: string;
  }): Promise<ReturnPathResult>;
}

export interface ReturnPathResult {
  /** What SES reports AFTER the write, never what was asked for. */
  enabled: boolean;
  mailFromDomain: string | null;
  status: DomainStatus;
}

export interface SesDomainsDeps {
  db?: CloudDb;
  /** Defaults to the process-wide client for the environment's pinned region. */
  ses?: SesClient;
  now?: () => Date;
}

/** The caller named a string that is not a domain. */
export class InvalidDomainError extends CloudServiceError {
  readonly code = "invalid_domain";

  constructor(readonly domain: string) {
    super(
      `"${domain}" is not a domain name. Use the bare domain you send from, e.g. "acme.com".`,
    );
  }
}

/**
 * The environment has no SES tenancy, so there is nothing to add a domain to.
 *
 * Its own error rather than a `NotFoundError` because the remedy is different:
 * the environment exists, it simply has not been provisioned onto Hogsend Email
 * yet, and telling the operator "not found" would send them looking for a typo.
 */
export class NoSesTenancyError extends CloudServiceError {
  readonly code = "email_not_provisioned";

  constructor(readonly environmentId: string) {
    super(
      `Environment "${environmentId}" has no Hogsend Email tenancy yet, so a sending domain cannot be added to it.`,
    );
  }
}

interface Tenancy {
  organizationId: string;
  tenantName: string;
  tenantArn: string;
  configurationSetName: string;
  awsRegion: SesRegion;
  region: SubstrateRegion;
}

export function createHogsendDomains(
  input: { environmentId: string; actor?: string },
  deps: SesDomainsDeps = {},
): HogsendDomains {
  const db = deps.db ?? defaultDb;
  const { environmentId } = input;
  const now = deps.now ?? (() => new Date());

  /** Resolved once per instance — every method needs the same three facts. */
  let cached: Promise<Tenancy> | undefined;
  const tenancy = (): Promise<Tenancy> => {
    cached ??= loadTenancy(db, environmentId);
    return cached;
  };

  const client = async (): Promise<SesClient> => {
    if (deps.ses) return deps.ses;
    return getSesClient((await tenancy()).region);
  };

  /** `null` rather than a throw for the one error that is an ordinary answer. */
  const readIdentity = async (domain: string): Promise<SesIdentity | null> => {
    const ses = await client();
    try {
      return await ses.getIdentity({ identity: domain });
    } catch (error) {
      if (error instanceof SesError && error.kind === "not_found") return null;
      throw error;
    }
  };

  const snapshot = async (
    domain: string,
    identity: SesIdentity,
  ): Promise<DomainStatus> => {
    const [{ awsRegion }, key] = await Promise.all([
      tenancy(),
      readDkimKey({ environmentId, domain }, { db }),
    ]);
    return toDomainStatus({
      domain,
      identity,
      // The PUBLIC half only. `readDkimKey` is the one path that can reach the
      // private one, and it stops here.
      publicKey: key?.publicKey,
      awsRegion,
      checkedAt: now().toISOString(),
    });
  };

  const get = async (domain: string): Promise<DomainStatus | null> => {
    const name = requireDomain(domain);
    const identity = await readIdentity(name);
    return identity ? snapshot(name, identity) : null;
  };

  return {
    async create(domain: string): Promise<DomainStatus> {
      const name = requireDomain(domain);
      const tenant = await tenancy();
      const ses = await client();

      // EARS 2. A domain SES already knows falls through to a lookup, and the
      // keypair branch below is never reached — so no second key is minted.
      const existing = await readIdentity(name);
      if (existing) return snapshot(name, existing);

      // A stored key ALWAYS wins. SES having lost the identity does not make
      // the record the customer published wrong; minting a new key would.
      const stored = await readDkimKey({ environmentId, domain: name }, { db });
      const keypair: DkimKeypair = stored ?? generateDkimKeypair();
      if (!stored) {
        // BEFORE the SES call, not after: if `CreateEmailIdentity` succeeds and
        // its answer is lost in transit, the retry finds the identity and needs
        // this key to render the record. A key persisted for an identity that
        // was never created costs nothing — the retry reuses it.
        await writeDkimKey({ environmentId, domain: name, keypair }, { db });
      }

      let identity: SesIdentity;
      try {
        identity = await ses.createIdentity({
          domain: name,
          configurationSetName: tenant.configurationSetName,
          // BYODKIM. This is the ONE TXT record instead of Easy DKIM's three
          // CNAMEs, and the 2048-bit signature instead of Resend's 1024.
          dkim: { selector: keypair.selector, privateKey: keypair.privateKey },
        });
      } catch (error) {
        // Lost a race with a concurrent create. Same answer as EARS 2.
        if (error instanceof SesError && error.kind === "already_exists") {
          const raced = await readIdentity(name);
          if (raced) return snapshot(name, raced);
        }
        // The ONE call that carries the private key on the wire, so it is the
        // one place a rejection could quote it back — the seam keeps AWS's
        // response body verbatim (correctly: a provision that failed at 03:00
        // has to be diagnosable), and this route surfaces that body in an HTTP
        // response and a log line. Redacted rather than discarded.
        throw redactSecret(error, keypair.privateKey);
      }

      // A send names a tenant, and SES only accepts it when the referenced
      // identity is ASSOCIATED with that tenant. Without this line every send
      // from the new domain is rejected — which is why the Fake models the same
      // precondition (PRD 02's implementation notes).
      await ses.associateResource({
        tenantName: tenant.tenantName,
        resourceArn: identityArn(tenant.tenantArn, name),
      });

      await writeAudit(db, {
        actor: input.actor ?? "system",
        organizationId: tenant.organizationId,
        action: "email_domain.created",
        subject: name,
        // Names and a selector. NEVER the key — not the private half, not the
        // public one, not a tail of either.
        detail: {
          environmentId,
          domain: name,
          selector: keypair.selector,
          tenantName: tenant.tenantName,
        },
      });

      return snapshot(name, identity);
    },

    get,

    async records(domain: string): Promise<DnsRecord[]> {
      return (await get(domain))?.records ?? [];
    },

    /**
     * SES has no "verify now" call — DKIM verification is a poll AWS runs
     * itself — so this is a fresh read, and EARS 8's answer for a domain that
     * was never created is a `not_found` STATUS rather than a throw.
     */
    async verify(domain: string): Promise<DomainStatus> {
      const name = requireDomain(domain);
      return (
        (await get(name)) ?? {
          domain: name,
          state: "not_found",
          records: [],
          providerId: HOGSEND_PROVIDER_ID,
          checkedAt: now().toISOString(),
        }
      );
    },

    async setReturnPath(toggle: {
      domain: string;
      enabled: boolean;
      label?: string;
    }): Promise<ReturnPathResult> {
      const name = requireDomain(toggle.domain);
      const tenant = await tenancy();
      const ses = await client();

      if (!(await readIdentity(name))) {
        throw new NotFoundError("Email identity", name);
      }

      await ses.setMailFrom({
        identity: name,
        // Empty reverts the identity to SES's default return path, which is
        // what "off" means. There is no separate delete operation.
        mailFromDomain: toggle.enabled
          ? mailFromDomainFor(name, toggle.label)
          : "",
        // NEVER `REJECT_MESSAGE`. A customer's MX breaking six months from now
        // must degrade to the default return path, not stop their mail.
        behaviorOnMxFailure: "USE_DEFAULT_VALUE",
      });

      await writeAudit(db, {
        actor: input.actor ?? "system",
        organizationId: tenant.organizationId,
        action: toggle.enabled
          ? "email_domain.return_path_enabled"
          : "email_domain.return_path_disabled",
        subject: name,
        detail: { environmentId, domain: name, tenantName: tenant.tenantName },
      });

      // Re-READ rather than assume. The answer describes what SES holds now,
      // so a write that silently did nothing cannot be reported as a success.
      const fresh = await ses.getIdentity({ identity: name });
      const mailFromDomain = fresh.mailFrom?.domain?.trim() || null;
      return {
        enabled: mailFromDomain !== null,
        mailFromDomain,
        status: await snapshot(name, fresh),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** What a redacted secret is replaced by. Visible, so a reader knows why. */
export const REDACTED_KEY = "[redacted:dkim-private-key]";

/**
 * Re-raise a `SesError` with the private key taken out of its message and its
 * response body, keeping the classification and every diagnostic field.
 *
 * Rebuilt rather than mutated because `SesError`'s fields are readonly, and
 * rebuilt rather than swallowed because the body is the only thing that makes a
 * 03:00 failure diagnosable. Anything that is not a `SesError` is passed
 * through untouched: it did not come from the wire, so it never saw the key.
 */
function redactSecret(error: unknown, secret: string): unknown {
  if (!(error instanceof SesError) || secret.length === 0) return error;
  const scrub = (value: string): string =>
    value.split(secret).join(REDACTED_KEY);
  if (!error.message.includes(secret) && !error.detail?.includes(secret)) {
    return error;
  }
  return new SesError(scrub(error.message), {
    kind: error.kind,
    ...(error.operation === undefined ? {} : { operation: error.operation }),
    ...(error.detail === undefined ? {} : { detail: scrub(error.detail) }),
    ...(error.awsErrorName === undefined
      ? {}
      : { awsErrorName: error.awsErrorName }),
    ...(error.httpStatusCode === undefined
      ? {}
      : { httpStatusCode: error.httpStatusCode }),
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
  });
}

function requireDomain(domain: string): string {
  const name = normalizeDomain(domain);
  if (!name) throw new InvalidDomainError(domain);
  return name;
}

/**
 * The neutral snapshot. The ONE function that decides how many records a
 * caller sees, which is why it takes the identity and nothing else that could
 * add one.
 */
function toDomainStatus(input: {
  domain: string;
  identity: SesIdentity;
  publicKey: string | undefined;
  awsRegion: SesRegion;
  checkedAt: string;
}): DomainStatus {
  const { identity } = input;
  const records: DnsRecord[] = [];

  // Omitted only when the identity exists with no key of ours — an identity
  // created out of band. Rendering a record we cannot sign for would be worse
  // than rendering none.
  if (input.publicKey) {
    records.push(
      dkimRecord(
        input.domain,
        input.publicKey,
        recordStatus(identity.dkim.status),
      ),
    );
  }

  // The branded return path, and ONLY when SES reports one. Off is the default
  // and off is the absence of these two records.
  const mailFromDomain = identity.mailFrom?.domain?.trim();
  if (mailFromDomain) {
    records.push(
      ...mailFromRecords({
        mailFromDomain,
        awsRegion: input.awsRegion,
        status: recordStatus(identity.mailFrom?.status),
      }),
    );
  }

  return {
    domain: input.domain,
    state: domainState(identity),
    records,
    providerId: HOGSEND_PROVIDER_ID,
    checkedAt: input.checkedAt,
    // The identity verbatim. It carries no key material — `SesIdentity` has no
    // private-key field, by construction of the seam.
    raw: identity,
  };
}

/**
 * EARS 4: verified means SES reports `DkimAttributes.Status: SUCCESS` with
 * `SigningAttributesOrigin: EXTERNAL` and `SigningEnabled: true`.
 *
 * All three, not just the status. `EXTERNAL` is what proves the identity is
 * verified by OUR key rather than by an Easy DKIM CNAME somebody added out of
 * band, and `SigningEnabled: false` is an identity that verifies and then signs
 * nothing — which reads as verified everywhere except in the recipient's DMARC
 * report.
 */
function domainState(identity: SesIdentity): DomainVerificationState {
  const { dkim } = identity;
  if (
    dkim.status === "SUCCESS" &&
    dkim.signingEnabled &&
    dkim.origin === "EXTERNAL"
  ) {
    return "verified";
  }
  if (dkim.status === "FAILED" || identity.verificationStatus === "FAILED") {
    return "failed";
  }
  return "pending";
}

function recordStatus(
  status: SesDkimStatus | SesMailFromStatus | undefined,
): DnsRecordStatus {
  if (status === "SUCCESS") return "verified";
  if (status === "FAILED") return "failed";
  if (status === undefined) return "unknown";
  return "pending";
}

/**
 * The identity's ARN, derived from the TENANT's — the same reasoning
 * `ses-tenants.ts` derives the configuration set's by. The control plane is
 * never told which AWS account its credentials belong to, and an ARN built
 * around a guessed account id fails as `not_found` at association time, which
 * reads like a missing resource rather than the misconfiguration it is.
 */
function identityArn(tenantArn: string, domain: string): string {
  const [prefix, partition, service, region, account] = tenantArn.split(":");
  if (prefix !== "arn" || !partition || !service || !region || !account) {
    throw new SesError(
      `cannot derive an identity ARN: tenant ARN ${JSON.stringify(
        tenantArn,
      )} is not an ARN`,
      { kind: "invalid" },
    );
  }
  return `arn:${partition}:${service}:${region}:${account}:identity/${domain}`;
}

async function loadTenancy(
  db: CloudDb,
  environmentId: string,
): Promise<Tenancy> {
  const tenant = await getSesTenant({ environmentId }, { db });
  if (!tenant) throw new NoSesTenancyError(environmentId);

  const [environment] = await db
    .select({ organizationId: environments.organizationId })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  if (!environment) throw new NotFoundError("Environment", environmentId);

  return {
    organizationId: environment.organizationId,
    tenantName: tenant.tenantName,
    tenantArn: tenant.tenantArn,
    configurationSetName: tenant.configurationSetName,
    awsRegion: tenant.awsRegion,
    // The region the tenant was minted IN, from the row — never the
    // organization's current one. Tenants are region-scoped and do not
    // replicate, so addressing another region would silently find nothing.
    region: tenant.region,
  };
}
