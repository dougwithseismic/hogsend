import { and, eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments, providerKeys } from "../db/schema";
import { decryptSecretPayload, encryptSecretPayload } from "../lib/crypto";
import { INBOUND_SUBDOMAIN } from "../lib/inbound-domains";
import type { CloudWriter } from "./audit";
import { NotFoundError } from "./errors";

/**
 * Where a domain's inbound settings live — above all, the human address every
 * received reply is forwarded to.
 *
 * This has to be DURABLE, and that is the whole reason the module exists. PRD
 * 16 makes forwarding mandatory whenever inbound is on: "A person replying to a
 * human expects a human to read it, so intercepting a reply and emitting only
 * an event breaks their business to gain a feature." A forwarding address that
 * lived only in the argument list of the call that enabled inbound would be
 * gone by the time the first reply arrived, and the receive path would have
 * nowhere to send it — which is exactly the silent swallow the EARS refusal
 * exists to prevent. SES is the register for WHICH domains receive; only we can
 * hold WHERE their mail goes.
 *
 * `provider_keys` is the store, for the same reason `ses-dkim-keys` uses it:
 * AES-256-GCM under `CLOUD_ENCRYPTION_SECRET`, one row per (environment,
 * provider), cascaded on environment delete. A second store for one more small
 * record would double the number of places a tenant deletion has to reach.
 * `last4` stays NULL and the payload is a FLAT `Record<string, string>`,
 * because `key-sync.ts` decrypts every credential row on every sync and
 * zod-parses each one as a flat string map — a nested payload here would throw
 * on a path that has nothing to do with inbound. `provider-env.ts` maps unknown
 * providers to no environment variables at all, so the row rides along inertly.
 *
 * A forwarding address is not a secret, and it is stored encrypted anyway
 * because the column is: it is a real person's mailbox, and the cheapest place
 * to keep it is the one that is already ciphertext-at-rest.
 */

/** The pseudo-provider id this module owns. Never in `PROVIDER_FORMS`. */
export const HOGSEND_INBOUND_PROVIDER = "hogsend-inbound";

export interface InboundConfig {
  /** The human mailbox every received reply is forwarded to. */
  forwardTo: string;
  /** The subdomain replies are received on — `reply` unless overridden. */
  label: string;
}

/** `|` is not legal in a domain name, so a field key cannot collide with one. */
function payloadField(domain: string, field: string): string {
  return `${domain}|${field}`;
}

export interface InboundConfigDeps {
  db?: CloudDb;
}

/** This environment's inbound settings for one domain, or `null`. */
export async function readInboundConfig(
  input: { environmentId: string; domain: string },
  deps: InboundConfigDeps = {},
): Promise<InboundConfig | null> {
  const payload = await readPayload(deps.db ?? defaultDb, input.environmentId);
  if (!payload) return null;

  const forwardTo = payload[payloadField(input.domain, "forward")];
  if (!forwardTo) return null;
  return {
    forwardTo,
    label: payload[payloadField(input.domain, "label")] ?? INBOUND_SUBDOMAIN,
  };
}

/**
 * Record a domain's inbound settings, merging into whatever this environment
 * already holds.
 *
 * OVERWRITES, unlike `writeDkimKey`'s add-only merge, and the asymmetry is the
 * point: re-publishing a DKIM key invalidates a record the customer has already
 * published, while changing a forwarding address is the ordinary thing an
 * operator does when the person who reads the replies changes jobs.
 *
 * Serialised on the ENVIRONMENT row, because the merge is a read-modify-write:
 * two concurrent enables for two different domains would otherwise both read
 * the same payload and the second write would drop the first domain's address —
 * leaving inbound on for a domain with nowhere to forward to, which is the one
 * state this whole feature refuses to create.
 */
export async function writeInboundConfig(
  input: { environmentId: string; domain: string; config: InboundConfig },
  deps: InboundConfigDeps = {},
): Promise<void> {
  await mutatePayload(deps.db ?? defaultDb, input.environmentId, (current) => ({
    ...current,
    [payloadField(input.domain, "forward")]: input.config.forwardTo,
    [payloadField(input.domain, "label")]: input.config.label,
  }));
}

/**
 * Forget a domain's inbound settings.
 *
 * Called on disable, so a re-enable has to restate the address rather than
 * inherit one nobody has looked at since. A stale forwarding destination for a
 * domain that stopped receiving is how mail ends up in an ex-employee's inbox
 * months later.
 */
export async function deleteInboundConfig(
  input: { environmentId: string; domain: string },
  deps: InboundConfigDeps = {},
): Promise<void> {
  await mutatePayload(deps.db ?? defaultDb, input.environmentId, (current) => {
    const next = { ...current };
    delete next[payloadField(input.domain, "forward")];
    delete next[payloadField(input.domain, "label")];
    return next;
  });
}

/**
 * THE TENANT BOUNDARY of the receive path: which environment does this envelope
 * recipient belong to?
 *
 * The recipient is `<anything>@<label>.<domain>` and the pair we hold is
 * (domain, label), so the derivation is exact rather than a guess:
 * `assertInboundLabel` refuses a label containing a dot, so `<label>.<domain>`
 * splits at the FIRST dot and nowhere else. `hello@reply.acme.com` can only
 * ever mean label `reply`, domain `acme.com`.
 *
 * It is a SCAN over the environments that have inbound configured, and that is
 * a deliberate trade rather than an oversight. The forwarding address is
 * ciphertext (see this module's note), so there is nothing to index on; the row
 * count is the number of environments that have opted INTO inbound, which is a
 * small subset of a small subset; and a received reply is orders of magnitude
 * rarer than a send. If that ever stops being true, the fix is a plaintext
 * `(domain, label) -> environment` lookup table written alongside this payload -
 * NOT a widening of what is stored in clear here.
 *
 * Returns `null` for a recipient nobody has enabled. That is an ordinary state
 * of the world: SES matches a rule on a DOMAIN, so a message can legitimately
 * arrive for a name whose config was deleted a moment earlier, and the caller
 * records it rather than throwing.
 */
export interface InboundRecipientOwner {
  environmentId: string;
  /** The customer domain, e.g. `acme.com`. */
  domain: string;
  label: string;
  forwardTo: string;
}

export async function findInboundRecipientOwner(
  recipient: string,
  deps: InboundConfigDeps = {},
): Promise<InboundRecipientOwner | null> {
  const at = recipient.lastIndexOf("@");
  if (at < 0) return null;
  const host = recipient
    .slice(at + 1)
    .trim()
    .toLowerCase();

  const dot = host.indexOf(".");
  if (dot <= 0) return null;
  const label = host.slice(0, dot);
  const domain = host.slice(dot + 1);
  // A base with no dot of its own is not a registrable domain, so the recipient
  // was addressed at an apex we never publish for. Refuse rather than search.
  if (!domain.includes(".")) return null;

  const db = deps.db ?? defaultDb;
  const rows = await db
    .select({
      environmentId: providerKeys.environmentId,
      encryptedPayload: providerKeys.encryptedPayload,
    })
    .from(providerKeys)
    .where(eq(providerKeys.provider, HOGSEND_INBOUND_PROVIDER));

  for (const row of rows) {
    let payload: Record<string, string>;
    try {
      payload = decryptSecretPayload<Record<string, string>>(
        row.encryptedPayload,
      );
    } catch {
      // One unreadable row (a rotated encryption secret, a hand edit) must not
      // make every OTHER tenant's replies unattributable. Skip it and keep
      // looking; the row is still visible to an operator.
      continue;
    }
    const forwardTo = payload[payloadField(domain, "forward")];
    if (!forwardTo) continue;
    if ((payload[payloadField(domain, "label")] ?? INBOUND_SUBDOMAIN) !== label)
      continue;
    return { environmentId: row.environmentId, domain, label, forwardTo };
  }

  return null;
}

async function mutatePayload(
  db: CloudDb,
  environmentId: string,
  mutate: (current: Record<string, string>) => Record<string, string>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [environment] = await tx
      .select({ organizationId: environments.organizationId })
      .from(environments)
      .where(eq(environments.id, environmentId))
      .limit(1)
      .for("update");
    if (!environment) throw new NotFoundError("Environment", environmentId);

    const payload = mutate((await readPayload(tx, environmentId)) ?? {});
    const values = {
      organizationId: environment.organizationId,
      environmentId,
      provider: HOGSEND_INBOUND_PROVIDER,
      encryptedPayload: encryptSecretPayload(payload),
      // Deliberately null — nothing renders a tail of a forwarding address.
      last4: null,
    };
    await tx
      .insert(providerKeys)
      .values(values)
      .onConflictDoUpdate({
        target: [providerKeys.environmentId, providerKeys.provider],
        set: {
          encryptedPayload: values.encryptedPayload,
          last4: null,
          updatedAt: new Date(),
        },
      });
  });
}

async function readPayload(
  writer: CloudWriter,
  environmentId: string,
): Promise<Record<string, string> | null> {
  const [row] = await writer
    .select({ encryptedPayload: providerKeys.encryptedPayload })
    .from(providerKeys)
    .where(
      and(
        eq(providerKeys.environmentId, environmentId),
        eq(providerKeys.provider, HOGSEND_INBOUND_PROVIDER),
      ),
    )
    .limit(1);
  if (!row) return null;
  return decryptSecretPayload<Record<string, string>>(row.encryptedPayload);
}
