"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import type { ActionState } from "@/src/lib/action-state";
import { NotPermittedError } from "@/src/lib/org-members";
import {
  describeRejection,
  describeRemoved,
  describeStored,
  proofOf,
  providerForm,
  providerLabel,
} from "@/src/lib/provider-catalog";
import {
  NoEmailProviderError,
  removeProviderKey,
  saveProviderKey,
  saveSenderIdentity,
} from "@/src/lib/provider-keys-ops";
import { CloudServiceError } from "@/src/services/errors";

/**
 * The three provider-credential mutations, as server actions.
 *
 * Each one is an adapter and nothing else: read the form using the field list
 * the catalog declares for that provider, call the enforced mutation in
 * `src/lib/provider-keys-ops.ts`, and turn the answer into one factual line.
 *
 * Two things this file must never do, and does not:
 *  - **Decide anything.** The owner/admin gate and the tenancy scope are below
 *    it; the live probe and the store-nothing-on-refusal rule are below that,
 *    in `KeySyncService`. These are POST endpoints anyone with a session can
 *    call, so a hidden button proves nothing.
 *  - **Echo a secret.** A submitted value is passed straight through and never
 *    logged, never returned in a message, never put in a `notice`. The only
 *    vocabulary that reaches a browser is the validator's slugs, rendered as
 *    sentences by `provider-catalog.ts`.
 */

/** Both surfaces render the same section, so both are revalidated. */
function revalidateProviders(): void {
  revalidatePath("/settings");
  revalidatePath("/setup/providers");
}

/**
 * A refusal is a rule the caller can act on; anything else is a bug that gets
 * one generic line plus a server-side log.
 */
function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof NotPermittedError) return error.message;
  if (error instanceof NoEmailProviderError) return error.message;
  if (error instanceof CloudServiceError) return error.message;
  console.error("[cloud] provider key action failed:", error);
  return fallback;
}

const targetSchema = z.object({
  environmentId: z.uuid({ message: "No environment was named." }),
  provider: z.string().min(1, "No provider was named."),
});

const addressSchema = z.object({
  environmentId: z.uuid({ message: "No environment was named." }),
  fromAddress: z
    .string()
    .trim()
    .min(3, "Enter the address your instance sends from.")
    .max(320),
});

function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

export async function saveProviderKeyAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = targetSchema.safeParse({
    environmentId: formData.get("environmentId"),
    provider: formData.get("provider"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  const form = providerForm(parsed.data.provider);
  if (!form) return { error: "That provider is not configurable here." };

  // Only the fields this provider declares are read: a form post carrying an
  // extra key must not become an env var nobody reviewed.
  const payload: Record<string, string> = {};
  for (const field of form.fields) {
    const value = text(formData, field.name);
    if (value.length > 0) payload[field.name] = value;
    else if (field.required) {
      return { error: `${field.label} is required.` };
    }
  }

  const fromAddress = form.email ? text(formData, "fromAddress") : "";

  let result: Awaited<ReturnType<typeof saveProviderKey>>;
  try {
    result = await saveProviderKey(await headers(), {
      environmentId: parsed.data.environmentId,
      provider: form.id,
      payload,
      ...(fromAddress ? { fromAddress } : {}),
    });
  } catch (error) {
    return { error: messageFrom(error, "The credential was not saved.") };
  }

  if (!result.stored) {
    return {
      error: describeRejection({
        reason: result.reason,
        detail: result.detail,
        provider: form.id,
      }),
    };
  }

  revalidateProviders();
  return {
    error: null,
    notice: describeStored({
      provider: form.id,
      proof: proofOf({
        provider: form.id,
        verifiedAt: result.key.verifiedAt,
        fieldsPresent: Object.keys(payload),
      }),
      synced: result.synced,
    }),
  };
}

/**
 * Set the sending address alone. The stored email key is replayed through the
 * same probe, so the address is still checked against a live domains list —
 * see `saveSenderIdentity`.
 */
export async function saveSenderIdentityAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = addressSchema.safeParse({
    environmentId: formData.get("environmentId"),
    fromAddress: formData.get("fromAddress"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  let result: Awaited<ReturnType<typeof saveSenderIdentity>>;
  try {
    result = await saveSenderIdentity(await headers(), parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "The address was not saved.") };
  }

  if (!result.stored) {
    return {
      error: describeRejection({
        reason: result.reason,
        detail: result.detail,
        provider: result.provider,
      }),
    };
  }

  revalidateProviders();
  return {
    error: null,
    notice: `Your instance now sends from ${parsed.data.fromAddress}, checked against ${providerLabel(
      result.provider,
    )}.${
      result.synced ? " The running instance was updated and restarted." : ""
    }`,
  };
}

export async function removeProviderKeyAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = targetSchema.safeParse({
    environmentId: formData.get("environmentId"),
    provider: formData.get("provider"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  let result: Awaited<ReturnType<typeof removeProviderKey>>;
  try {
    result = await removeProviderKey(await headers(), parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "The credential was not removed.") };
  }

  revalidateProviders();
  if (!result.removed) {
    return {
      error: null,
      notice: `There was no ${providerLabel(parsed.data.provider)} credential to remove.`,
    };
  }

  return {
    error: null,
    notice: describeRemoved({
      provider: parsed.data.provider,
      inert: result.inert,
      synced: result.synced,
    }),
  };
}
