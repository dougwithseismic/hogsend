/**
 * The one mapping from STORED tenant credentials to the engine env vars their
 * plugins read.
 *
 * Two callers share it and must not drift: the provisioning pipeline's `set-env`
 * step (a stack that has not booted yet) and `key-sync.ts` (a stack that is
 * already running). A duplicated copy would mean a key that works on a fresh
 * stack and silently does nothing on a rotation — the kind of bug nobody finds
 * until a tenant's email stops sending.
 *
 * The module is PURE: no db, no crypto, no clock. Everything it needs arrives as
 * decrypted payloads, so it can be reasoned about (and tested) as a function.
 *
 * Two laws:
 *  - **Unknown providers contribute nothing.** The control plane must not invent
 *    an env var name the engine would ignore.
 *  - **It OWNS the names it can write** (`PROVIDER_ENV_OWNED_NAMES`). That list
 *    is what makes removal honest: a sync sends `null` for every owned name the
 *    current credentials no longer produce, so deleting a key actually unsets
 *    the variable rather than leaving a dead one behind.
 */

/**
 * The sender identity is stored as a PSEUDO-PROVIDER row rather than a column.
 *
 * `provider_keys` already gives us exactly what a from-address needs — one row
 * per (environment, provider), encrypted at rest, upsert-replaces on rotation,
 * audited on every mutation, cascaded on environment delete — and a dedicated
 * column would need a migration plus a second removal path for no new capability.
 * The trade is that `last4` for this row is the tail of an email address rather
 * than of a secret; harmless, and the address is tenant-owned public data.
 */
export const SENDER_IDENTITY_PROVIDER = "sender-identity";

/** One decrypted credential, as `ProviderKeyService.getDecrypted` returns it. */
export interface StoredProviderKey {
  provider: string;
  payload: Record<string, string>;
}

export interface BuildProviderEnvInput {
  keys: StoredProviderKey[];
  /**
   * Overrides any stored sender identity. Used by the sync path, where the
   * address being submitted has just been checked against the provider's
   * verified domains and has not been persisted yet.
   */
  fromAddress?: string | undefined;
}

/**
 * Every env name this module may write, per provider. Exported as data so a
 * removal can compute its unset list without re-deriving the switch below.
 */
export const PROVIDER_ENV_NAMES: Record<string, readonly string[]> = {
  resend: ["RESEND_API_KEY", "RESEND_FROM_EMAIL"],
  postmark: ["POSTMARK_SERVER_TOKEN", "POSTMARK_MESSAGE_STREAM"],
  posthog: ["POSTHOG_API_KEY", "POSTHOG_PERSONAL_API_KEY", "POSTHOG_HOST"],
  twilio: [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_MESSAGING_SERVICE_SID",
  ],
  [SENDER_IDENTITY_PROVIDER]: ["EMAIL_FROM", "EMAIL_DOMAIN"],
};

/** The union of the above — the names a sync is entitled to unset. */
export const PROVIDER_ENV_OWNED_NAMES: readonly string[] = [
  ...new Set(Object.values(PROVIDER_ENV_NAMES).flat()),
].sort();
/** The domain half of an address, or null when there is not one. */
export function emailDomainOf(address: string): string | null {
  const trimmed = address.trim().replace(/^.*<|>$/g, "");
  const at = trimmed.lastIndexOf("@");
  if (at === -1) return null;
  const domain = trimmed.slice(at + 1).toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

function pick(
  payload: Record<string, string>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function set(
  target: Record<string, string>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

/** Map ONE stored credential onto its engine env vars. */
function providerEnv(
  provider: string,
  payload: Record<string, string>,
): Record<string, string> {
  const vars: Record<string, string> = {};
  switch (provider) {
    case "resend":
      set(vars, "RESEND_API_KEY", pick(payload, "apiKey", "api_key", "key"));
      set(vars, "RESEND_FROM_EMAIL", pick(payload, "fromEmail", "from"));
      break;
    case "postmark":
      set(
        vars,
        "POSTMARK_SERVER_TOKEN",
        pick(payload, "serverToken", "apiKey", "token"),
      );
      set(vars, "POSTMARK_MESSAGE_STREAM", pick(payload, "messageStream"));
      break;
    case "posthog":
      set(vars, "POSTHOG_API_KEY", pick(payload, "apiKey", "projectApiKey"));
      set(vars, "POSTHOG_PERSONAL_API_KEY", pick(payload, "personalApiKey"));
      set(vars, "POSTHOG_HOST", pick(payload, "host"));
      break;
    case "twilio":
      set(vars, "TWILIO_ACCOUNT_SID", pick(payload, "accountSid"));
      set(vars, "TWILIO_AUTH_TOKEN", pick(payload, "authToken"));
      set(
        vars,
        "TWILIO_MESSAGING_SERVICE_SID",
        pick(payload, "messagingServiceSid", "messagingService"),
      );
      break;
    case SENDER_IDENTITY_PROVIDER:
      set(vars, "EMAIL_FROM", pick(payload, "from", "fromEmail", "address"));
      break;
    default:
      break;
  }
  return vars;
}

/**
 * The complete provider-derived env for one environment.
 *
 * `EMAIL_FROM` is the neutral address the engine prefers; it comes from the
 * sender-identity row (or the explicit override), falling back to the legacy
 * `RESEND_FROM_EMAIL` so a stack configured before sender identities existed
 * keeps sending from the address it always did. `EMAIL_DOMAIN` is derived from
 * whichever won — never let the two disagree.
 */
export function buildProviderEnv(
  input: BuildProviderEnvInput,
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const key of input.keys) {
    Object.assign(vars, providerEnv(key.provider, key.payload));
  }

  if (input.fromAddress) vars.EMAIL_FROM = input.fromAddress;
  if (!vars.EMAIL_FROM && vars.RESEND_FROM_EMAIL) {
    vars.EMAIL_FROM = vars.RESEND_FROM_EMAIL;
  }

  const emailFrom = vars.EMAIL_FROM;
  if (emailFrom && !vars.EMAIL_DOMAIN) {
    const domain = emailDomainOf(emailFrom);
    if (domain) vars.EMAIL_DOMAIN = domain;
  }

  return vars;
}
