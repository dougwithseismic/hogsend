import { and, eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments, stacks } from "../db/schema";
import { NotFoundError } from "../services/errors";
import type {
  RemoveAndSyncResult,
  StoreAndSyncResult,
} from "../services/key-sync";
import { KeySyncService, keySyncService } from "../services/key-sync";
import type { StackRow } from "../services/orgs";
import type { StoredProviderKey } from "../services/provider-env";
import { SENDER_IDENTITY_PROVIDER } from "../services/provider-env";
import type { ProviderKeySummary } from "../services/provider-keys";
import {
  providerKeyService as defaultProviderKeys,
  ProviderKeyService,
} from "../services/provider-keys";
import type { OrgMembersDeps } from "./org-members";
import { NotPermittedError, readMemberContext, roleList } from "./org-members";
import {
  EMAIL_PROVIDER_IDS,
  PROVIDER_FORMS,
  type ProviderForm,
  type ProviderProof,
  proofOf,
  providerForm,
  SENDER_IDENTITY_FIELD,
} from "./provider-catalog";

/**
 * The provider-credential half of the settings page, and the rules that gate
 * it — the twin of `lib/environment-ops.ts`, for the same reason.
 *
 * The server actions above this file parse forms. Every rule lives HERE, where
 * a test can reach it with a real session and no Next request:
 *
 *  1. **Owner or admin to mutate.** A member may see that Resend is configured
 *     and when it was checked; only an operator may paste, rotate or remove a
 *     credential. A hidden button is not a permission check — the action is a
 *     POST endpoint anyone with a session can call.
 *  2. **The environment belongs to the CALLER's organization.** Scoped in the
 *     query, so a cross-tenant id reads as "not found" rather than confirming
 *     it exists somewhere else.
 *  3. **Nothing is validated or stored here.** That is `KeySyncService`'s job
 *     (prove first, store second, sync a running stack, audit). This module
 *     never sees a decision it could get wrong; it only decides WHO may ask.
 *
 * And the read law: what leaves this module for a screen is provider, last4,
 * proof, timestamps — and, for the PostHog "is it live-checkable" question,
 * the payload's FIELD NAMES. Never a value.
 */

/** Roles allowed to add, rotate and remove a provider credential. */
const OPERATOR_ROLES = new Set<string>(["owner", "admin"]);

export function canManageProviderKeys(
  role: string | null | undefined,
): boolean {
  return roleList(role).some((value) => OPERATOR_ROLES.has(value));
}

export function assertCanManageProviderKeys(
  role: string | null | undefined,
): void {
  if (!canManageProviderKeys(role)) {
    throw new NotPermittedError(
      "Only an owner or admin can change provider credentials.",
    );
  }
}

/** A sender identity was submitted with no email provider to check it. */
export class NoEmailProviderError extends Error {
  readonly code = "no_email_provider";

  constructor() {
    super(
      "Add a Resend or Postmark key first — a sending address is checked against that provider's verified domains.",
    );
    this.name = "NoEmailProviderError";
  }
}

export interface ProviderKeysDeps extends OrgMembersDeps {
  db?: CloudDb;
  providerKeys?: ProviderKeyService;
  keySync?: KeySyncService;
}

function resolveDeps(deps: ProviderKeysDeps): {
  db: CloudDb;
  providerKeys: ProviderKeyService;
  keySync: KeySyncService;
} {
  const db = deps.db ?? defaultDb;
  return {
    db,
    providerKeys:
      deps.providerKeys ??
      (deps.db ? new ProviderKeyService(deps.db) : defaultProviderKeys),
    keySync:
      deps.keySync ??
      (deps.db ? new KeySyncService({ db: deps.db }) : keySyncService),
  };
}

/** One environment as the providers surface names it. */
export interface ProviderEnvironmentOption {
  id: string;
  name: string;
  kind: "production" | "staging" | "test";
  /** null when the environment has no stack row at all. */
  stackStatus: StackRow["status"] | null;
}

/** One provider's state, as a screen may see it. Carries no secret. */
export interface ProviderKeyState {
  provider: string;
  configured: boolean;
  last4: string | null;
  verifiedAt: Date | null;
  updatedAt: Date | null;
  /** The payload's field NAMES — what makes the PostHog proof honest. */
  fieldsPresent: string[];
  proof: ProviderProof | null;
}

export interface ProvidersView {
  canManage: boolean;
  role: string;
  organizationId: string;
  environments: ProviderEnvironmentOption[];
  /** null only when the organization has no environments at all. */
  selected: ProviderEnvironmentOption | null;
  /** The four provider forms, with the state of each. */
  providers: Array<{ form: ProviderForm; state: ProviderKeyState }>;
  /** The from-address row, and which email provider would check it. */
  sender: ProviderKeyState & { checkedBy: string | null };
}

function emptyState(provider: string): ProviderKeyState {
  return {
    provider,
    configured: false,
    last4: null,
    verifiedAt: null,
    updatedAt: null,
    fieldsPresent: [],
    proof: null,
  };
}

/**
 * Which environments this caller's organization has, ordered production first
 * — the one a tenant means when they say "my instance".
 */
async function listEnvironments(
  db: CloudDb,
  organizationId: string,
): Promise<ProviderEnvironmentOption[]> {
  const rows = await db
    .select({
      id: environments.id,
      name: environments.name,
      kind: environments.kind,
      stackStatus: stacks.status,
    })
    .from(environments)
    .leftJoin(stacks, eq(stacks.environmentId, environments.id))
    .where(eq(environments.organizationId, organizationId))
    .orderBy(environments.name);

  return rows
    .map((row) => ({ ...row, stackStatus: row.stackStatus ?? null }))
    .sort((a, b) => {
      if (a.kind === b.kind) return a.name.localeCompare(b.name);
      return a.kind === "production" ? -1 : b.kind === "production" ? 1 : 0;
    });
}

/**
 * The payload's field names for one stored credential.
 *
 * It decrypts to read `Object.keys` and returns nothing else — the alternative
 * (a `has_personal_key` column) would be a migration and a second write path
 * for a fact the payload already holds.
 */
async function fieldsPresent(
  providerKeys: ProviderKeyService,
  environmentId: string,
  provider: string,
): Promise<string[]> {
  const decrypted = await providerKeys.getDecrypted({
    environmentId,
    provider,
  });
  if (!decrypted.found) return [];
  return Object.entries(decrypted.payload)
    .filter(([, value]) => value.length > 0)
    .map(([name]) => name)
    .sort();
}

/**
 * Everything the providers section renders, for ONE environment.
 *
 * `environmentId` is a REQUEST, not a fact: an id from another organization
 * falls back to the caller's default environment rather than throwing, because
 * a bookmarked query string is not an attack worth a 500 — and it can never
 * read another tenant's keys, since the id is filtered by organization first.
 */
export async function readProvidersView(
  headers: Headers,
  input: { environmentId?: string | undefined } = {},
  deps: ProviderKeysDeps = {},
): Promise<ProvidersView> {
  const { db, providerKeys } = resolveDeps(deps);
  const context = await readMemberContext(headers, deps);
  const options = await listEnvironments(db, context.organizationId);
  const selected =
    options.find((option) => option.id === input.environmentId) ??
    options[0] ??
    null;

  const base = {
    canManage: canManageProviderKeys(context.role),
    role: context.role,
    organizationId: context.organizationId,
    environments: options,
    selected,
  };

  if (!selected) {
    return {
      ...base,
      providers: PROVIDER_FORMS.map((form) => ({
        form,
        state: emptyState(form.id),
      })),
      sender: { ...emptyState(SENDER_IDENTITY_PROVIDER), checkedBy: null },
    };
  }

  const { keys } = await providerKeys.list({ environmentId: selected.id });
  const byProvider = new Map<string, ProviderKeySummary>(
    keys.map((key) => [key.provider, key]),
  );

  const state = async (provider: string): Promise<ProviderKeyState> => {
    const key = byProvider.get(provider);
    if (!key) return emptyState(provider);
    const present = await fieldsPresent(providerKeys, selected.id, provider);
    return {
      provider,
      configured: true,
      last4: key.last4,
      verifiedAt: key.verifiedAt,
      updatedAt: key.updatedAt,
      fieldsPresent: present,
      proof: proofOf({
        provider,
        verifiedAt: key.verifiedAt,
        fieldsPresent: present,
      }),
    };
  };

  const providers = await Promise.all(
    PROVIDER_FORMS.map(async (form) => ({
      form,
      state: await state(form.id),
    })),
  );

  return {
    ...base,
    providers,
    sender: {
      ...(await state(SENDER_IDENTITY_PROVIDER)),
      checkedBy: EMAIL_PROVIDER_IDS.find((id) => byProvider.has(id)) ?? null,
    },
  };
}

/** The caller's organization + an environment inside it, or `NotFoundError`. */
async function resolveTarget(
  headers: Headers,
  input: { environmentId: string },
  deps: ProviderKeysDeps,
): Promise<{ organizationId: string; environmentId: string; actor: string }> {
  const { db } = resolveDeps(deps);
  const context = await readMemberContext(headers, deps);
  assertCanManageProviderKeys(context.role);

  const [row] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(
      and(
        eq(environments.id, input.environmentId),
        eq(environments.organizationId, context.organizationId),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("Environment", input.environmentId);

  return {
    organizationId: context.organizationId,
    environmentId: row.id,
    actor: context.userId,
  };
}

export interface SaveProviderKeyInput {
  environmentId: string;
  provider: string;
  /** Field name → submitted value. Blank values are dropped by the caller. */
  payload: Record<string, string>;
  /** Optional sending address, checked against this provider's domains. */
  fromAddress?: string | undefined;
}

/**
 * Store one credential (and, when given, the sending address beside it).
 *
 * Returns `StoreAndSyncResult` verbatim: a refusal is an ordinary answer a
 * form prints, not an exception, and the action turns its slug into a sentence
 * through `provider-catalog.ts`.
 */
export async function saveProviderKey(
  headers: Headers,
  input: SaveProviderKeyInput,
  deps: ProviderKeysDeps = {},
): Promise<StoreAndSyncResult> {
  const { keySync } = resolveDeps(deps);
  const target = await resolveTarget(headers, input, deps);

  return keySync.storeAndSync({
    organizationId: target.organizationId,
    environmentId: target.environmentId,
    provider: input.provider,
    payload: input.payload,
    ...(input.fromAddress ? { fromAddress: input.fromAddress } : {}),
    actor: target.actor,
  });
}

/**
 * Set the sending address on its own, re-using the STORED email key.
 *
 * `storeAndSync` is deliberately one unit — validate the provider key, then
 * gate the address on the domains that same probe returned — so changing an
 * address means re-proving the key it will send through. The stored payload is
 * replayed for that, rather than asking a tenant to paste their key again to
 * fix a typo in a from-address.
 */
export async function saveSenderIdentity(
  headers: Headers,
  input: { environmentId: string; fromAddress: string },
  deps: ProviderKeysDeps = {},
): Promise<StoreAndSyncResult & { provider: string }> {
  const { providerKeys, keySync } = resolveDeps(deps);
  const target = await resolveTarget(headers, input, deps);

  const stored = await firstStoredEmailKey(providerKeys, target.environmentId);
  if (!stored) throw new NoEmailProviderError();

  const result = await keySync.storeAndSync({
    organizationId: target.organizationId,
    environmentId: target.environmentId,
    provider: stored.provider,
    payload: stored.payload,
    fromAddress: input.fromAddress,
    actor: target.actor,
  });
  return { ...result, provider: stored.provider };
}

async function firstStoredEmailKey(
  providerKeys: ProviderKeyService,
  environmentId: string,
): Promise<StoredProviderKey | null> {
  for (const provider of EMAIL_PROVIDER_IDS) {
    const decrypted = await providerKeys.getDecrypted({
      environmentId,
      provider,
    });
    if (decrypted.found) {
      return { provider, payload: decrypted.payload };
    }
  }
  return null;
}

/**
 * Delete a credential and unset its env vars. The `inert` list comes back from
 * the service so the confirmation the tenant read and the sentence they get
 * after are the same list.
 */
export async function removeProviderKey(
  headers: Headers,
  input: { environmentId: string; provider: string },
  deps: ProviderKeysDeps = {},
): Promise<RemoveAndSyncResult> {
  const { keySync } = resolveDeps(deps);
  const target = await resolveTarget(headers, input, deps);

  return keySync.removeAndSync({
    organizationId: target.organizationId,
    environmentId: target.environmentId,
    provider: input.provider,
    actor: target.actor,
  });
}

/** Whether a provider id is one this surface offers a form for. */
export function isKnownProvider(provider: string): boolean {
  return (
    provider === SENDER_IDENTITY_PROVIDER || Boolean(providerForm(provider))
  );
}

export { SENDER_IDENTITY_FIELD, SENDER_IDENTITY_PROVIDER };
