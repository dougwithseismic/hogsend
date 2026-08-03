import { inertFeatures } from "../services/key-sync";
import { VALIDATABLE_PROVIDERS } from "../services/key-validation";
import { SENDER_IDENTITY_PROVIDER } from "../services/provider-env";

/**
 * What a tenant is asked for, and what they are told back.
 *
 * Two things live here and nowhere else:
 *
 *  - **The form shape per provider.** Which fields a credential needs, which of
 *    them is the secret, and what each one is for. The engine's plugin decides
 *    the field NAMES (`provider-env.ts` maps them to env vars); this module is
 *    the human side of the same table, so a field added there has one obvious
 *    place to appear.
 *  - **The slug → sentence mapping.** `key-validation.ts` answers in a fixed
 *    vocabulary of slugs on purpose (a vendor's prose is not a contract, and
 *    may quote the credential back). Every screen that shows a refusal goes
 *    through {@link describeRejection}, so the wording cannot drift between the
 *    settings page and the onboarding step.
 *
 * The copy law: a sentence here states what IS. Nothing claims a credential is
 * live unless a provider answered a real request about it — which is why
 * `shape_only` has a sentence of its own rather than borrowing "verified".
 *
 * Pure: no database, no `next/*`, no secrets. Importable from a client
 * component.
 */

export type ProviderFieldKind = "secret" | "text";

export interface ProviderField {
  /** The payload key. Must match what `provider-env.ts` reads. */
  name: string;
  label: string;
  kind: ProviderFieldKind;
  required: boolean;
  /** One factual line under the input: format, or where to find it. */
  hint?: string;
  placeholder?: string;
}

export interface ProviderForm {
  id: string;
  label: string;
  /** What this credential turns on, in tenant words. */
  purpose: string;
  /** True for providers whose key also carries the sending identity. */
  email: boolean;
  fields: ProviderField[];
  /** What stops working when it is removed (from `key-sync.ts`). */
  inert: readonly string[];
}

/** The address every send leaves from. Stored as a pseudo-provider row. */
export const SENDER_IDENTITY_FIELD = "from";

export const PROVIDER_FORMS: readonly ProviderForm[] = [
  {
    id: "resend",
    label: "Resend",
    purpose: "Sends email for journeys, broadcasts and transactional messages.",
    email: true,
    fields: [
      {
        name: "apiKey",
        label: "API key",
        kind: "secret",
        required: true,
        hint: "Checked against Resend's domains endpoint before it is stored.",
        placeholder: "re_…",
      },
    ],
    inert: inertFeatures("resend"),
  },
  {
    id: "postmark",
    label: "Postmark",
    purpose:
      "An alternative email provider. Configure Resend or Postmark, not both.",
    email: true,
    fields: [
      {
        name: "serverToken",
        label: "Server API token",
        kind: "secret",
        required: true,
        hint: "The server token, not the account token. Checked against Postmark's /server endpoint.",
      },
    ],
    inert: inertFeatures("postmark"),
  },
  {
    id: "posthog",
    label: "PostHog",
    purpose:
      "Mirrors events to PostHog and reads person properties for journey conditions.",
    email: false,
    fields: [
      {
        name: "apiKey",
        label: "Project API key",
        kind: "secret",
        required: true,
        hint: "The phc_ key. PostHog exposes no read endpoint for it, so it is checked for shape only.",
        placeholder: "phc_…",
      },
      {
        name: "host",
        label: "Host",
        kind: "text",
        required: false,
        hint: "Leave blank for https://us.posthog.com. EU projects use https://eu.posthog.com.",
        placeholder: "https://us.posthog.com",
      },
      {
        name: "personalApiKey",
        label: "Personal API key",
        kind: "secret",
        required: false,
        hint: "Optional, and live-checked when given. Without it, person-property reads soft-fail.",
        placeholder: "phx_…",
      },
    ],
    inert: inertFeatures("posthog"),
  },
  {
    id: "twilio",
    label: "Twilio",
    purpose: "Sends SMS and receives inbound STOP/START.",
    email: false,
    fields: [
      {
        name: "accountSid",
        label: "Account SID",
        kind: "text",
        required: true,
        placeholder: "AC…",
      },
      {
        name: "authToken",
        label: "Auth token",
        kind: "secret",
        required: true,
        hint: "The SID and token are checked together against Twilio's account endpoint.",
      },
      {
        name: "messagingServiceSid",
        label: "Messaging service SID",
        kind: "text",
        required: false,
        hint: "Optional here; SMS sends need one at the engine.",
        placeholder: "MG…",
      },
    ],
    inert: inertFeatures("twilio"),
  },
];

/** Providers with an add/rotate form, in render order. */
export const PROVIDER_IDS: readonly string[] = PROVIDER_FORMS.map(
  (form) => form.id,
);

export function providerForm(id: string): ProviderForm | undefined {
  return PROVIDER_FORMS.find((form) => form.id === id);
}

export function providerLabel(id: string): string {
  if (id === SENDER_IDENTITY_PROVIDER) return "Sending address";
  return providerForm(id)?.label ?? id;
}

/**
 * Every provider this form offers must have a validator: `storeAndSync`
 * refuses an unprovable credential, so a form for one would be a control that
 * can only ever fail. Asserted at module load rather than in a test alone.
 */
for (const form of PROVIDER_FORMS) {
  if (!VALIDATABLE_PROVIDERS.includes(form.id)) {
    throw new Error(
      `Provider form "${form.id}" has no validator; it could never be stored`,
    );
  }
}

/** The email providers, in preference order — the sender identity's owners. */
export const EMAIL_PROVIDER_IDS: readonly string[] = PROVIDER_FORMS.filter(
  (form) => form.email,
).map((form) => form.id);

/**
 * How well a stored credential is actually proven.
 *
 *  - `live` — a provider answered a real request about this exact credential.
 *  - `shape_only` — it matched the shape the provider issues and nothing more.
 *    PostHog's `phc_` project key is the case this exists for: it is write-only
 *    by design, and every read-shaped probe would persist an event in the
 *    tenant's project.
 *  - `unproven` — stored, but no provider confirmed it. A sending address on a
 *    provider that publishes no verified-domain list lands here.
 */
export type ProviderProof = "live" | "shape_only" | "unproven";

export interface ProofInput {
  provider: string;
  verifiedAt: Date | null;
  /** The payload's FIELD NAMES. Never its values. */
  fieldsPresent: readonly string[];
}

export function proofOf(input: ProofInput): ProviderProof {
  // PostHog is proven by its PERSONAL key or not at all — see the field hint.
  if (input.provider === "posthog") {
    return input.fieldsPresent.includes("personalApiKey") && input.verifiedAt
      ? "live"
      : "shape_only";
  }
  return input.verifiedAt ? "live" : "unproven";
}

/** The chip next to a configured credential. Never green unless `live`. */
export function proofLabel(proof: ProviderProof): string {
  switch (proof) {
    case "live":
      return "verified";
    case "shape_only":
      return "shape checked";
    default:
      return "unverified";
  }
}

export function proofTone(proof: ProviderProof): "good" | "caution" {
  return proof === "live" ? "good" : "caution";
}

/** The sentence under a configured credential, per proof. */
export function proofSentence(
  provider: string,
  proof: ProviderProof,
  verifiedAt: Date | null,
): string {
  if (proof === "live" && verifiedAt) {
    return `Checked against ${providerLabel(provider)} on ${verifiedAt
      .toISOString()
      .slice(0, 10)}.`;
  }
  if (proof === "shape_only") {
    return "Stored — PostHog accepts writes without read validation, so the project key was checked for shape only. Add a personal API key to have it checked live.";
  }
  if (provider === SENDER_IDENTITY_PROVIDER) {
    return "Stored, unverified: this provider publishes no verified-domain list, so the address is checked by the provider at send time.";
  }
  return "Stored, unverified: no provider has confirmed this credential.";
}

/**
 * Turn a validator slug into a sentence.
 *
 * `reason` is the refusal's kind (`invalid_key`, `from_address_malformed`,
 * `from_domain_unverified`) and `detail` is the slug. Every branch ends by
 * saying that nothing was stored, because that is the part a tenant acts on:
 * the environment is exactly as it was.
 */
export function describeRejection(input: {
  reason: "invalid_key" | "from_address_malformed" | "from_domain_unverified";
  detail: string;
  provider: string;
}): string {
  const name = providerLabel(input.provider);

  if (input.reason === "from_domain_unverified") {
    return `${input.detail} is not a verified sending domain on this ${name} account. Verify it with ${name} first. Nothing was stored.`;
  }
  if (input.reason === "from_address_malformed") {
    return "That is not an email address. Nothing was stored.";
  }

  const missing = input.detail.match(/^missing_field:(.+)$/);
  if (missing) {
    return `${missing[1]} is required. Nothing was stored.`;
  }

  const http = input.detail.match(/^http_(\d+)$/);
  if (http) {
    return `${name} answered HTTP ${http[1]}. Nothing was stored.`;
  }

  switch (input.detail) {
    case "unauthorized":
      return `${name} rejected that credential. Nothing was stored.`;
    case "not_found":
      return `${name} has no account for those details. Nothing was stored.`;
    case "unreachable":
      return `${name} could not be reached within 5 seconds. Nothing was stored.`;
    case "malformed_key":
      return `That is not the shape of key ${name} issues. Nothing was stored.`;
    case "unsupported_provider":
      return `${name} credentials cannot be checked, so they are not accepted here.`;
    default:
      return `${name} did not confirm that credential (${input.detail}). Nothing was stored.`;
  }
}

/** The success line: what was stored, and whether a stack was restarted. */
export function describeStored(input: {
  provider: string;
  proof: ProviderProof;
  synced: boolean;
}): string {
  const name = providerLabel(input.provider);
  const proven =
    input.proof === "shape_only"
      ? `${name} key stored; its shape was checked, not the key itself.`
      : `${name} key stored and checked live.`;
  return `${proven} ${
    input.synced
      ? "The running instance was updated and restarted."
      : "The environment picks it up when its stack starts."
  }`;
}

/** The success line for a removal, naming what just went inert. */
export function describeRemoved(input: {
  provider: string;
  inert: readonly string[];
  synced: boolean;
}): string {
  const name = providerLabel(input.provider);
  const inert =
    input.inert.length > 0
      ? ` Now inert: ${input.inert.join("; ")}.`
      : " Nothing else was affected.";
  return `${name} credential removed.${inert}${
    input.synced
      ? " Its environment variables were unset and the instance restarted."
      : ""
  }`;
}
