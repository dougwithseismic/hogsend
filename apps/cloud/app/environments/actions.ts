"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import type {
  ActionState,
  PublishTokenState,
  SecretRevealState,
} from "@/src/lib/action-state";
import { rotatePublishToken } from "@/src/lib/build-views";
import {
  ConfirmationMismatchError,
  createEnvironment,
  destroyEnvironment,
  resumeEnvironment,
  retryEnvironmentProvisioning,
  rollbackEnvironment,
  suspendEnvironment,
} from "@/src/lib/environment-ops";
import { NotPermittedError } from "@/src/lib/org-members";
import {
  createTenantKey,
  revealIngestSnippet,
  revealStudioPassword,
  revokeTenantKey,
  tenantErrorMessage,
} from "@/src/lib/tenant-access";
import {
  CloudServiceError,
  IllegalTransitionError,
} from "@/src/services/errors";

/**
 * Environment creation and the four stack operations, as server actions.
 *
 * Each one is an adapter and nothing more: parse the form, call the enforced
 * mutation in `src/lib/environment-ops.ts`, turn a refusal into a line the form
 * can print. Every rule — the owner/admin gate, the tenancy scope, the destroy
 * confirmation, the legal-edge table — is checked BELOW this file, because
 * these are POST endpoints anyone with a session can reach and a disabled
 * button is not a permission check.
 *
 * Every one revalidates BOTH `/environments` and the environment's own page:
 * the controls are on the detail page, and the list and the overview's status
 * chips are reading the same row.
 */

/** The two pages that render this environment's status. */
function revalidateEnvironment(environmentId: string): void {
  revalidatePath("/environments");
  revalidatePath(`/environments/${environmentId}`);
  revalidatePath("/");
}

const environmentSchema = z.object({
  environmentId: z.uuid({ message: "No environment was named." }),
});

const destroySchema = environmentSchema.extend({
  confirm: z.string().min(1, "Type the environment name to confirm."),
});

/**
 * A refusal is a RULE the caller can act on; anything else is a bug. The typed
 * errors are printed verbatim — they already read as sentences — and everything
 * else gets one generic line plus a server-side log, so an infrastructure
 * detail never reaches a browser.
 */
function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof NotPermittedError) return error.message;
  if (error instanceof ConfirmationMismatchError) return error.message;
  if (error instanceof IllegalTransitionError) return error.message;
  if (error instanceof CloudServiceError) return error.message;
  console.error("[cloud] environment action failed:", error);
  return fallback;
}

export async function suspendEnvironmentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = environmentSchema.safeParse({
    environmentId: formData.get("environmentId"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  try {
    await suspendEnvironment(await headers(), parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "The environment was not suspended.") };
  }

  revalidateEnvironment(parsed.data.environmentId);
  return { error: null, notice: "Environment suspended." };
}

export async function resumeEnvironmentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = environmentSchema.safeParse({
    environmentId: formData.get("environmentId"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  try {
    await resumeEnvironment(await headers(), parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "The environment was not resumed.") };
  }

  revalidateEnvironment(parsed.data.environmentId);
  return { error: null, notice: "Environment resumed." };
}

const rollbackSchema = z.object({
  environmentId: z.uuid(),
  buildId: z.uuid(),
});

/**
 * Put a previous build back on this environment's stack.
 *
 * Unlike destroy, there is no typed confirmation: a rollback is reversible by
 * rolling forward again, and the thing it CANNOT undo — database migrations —
 * is not something a confirmation box would make safer. Saying so on the
 * control is the honest guard; making the customer type a name would only
 * imply we had it covered.
 */
export async function rollbackEnvironmentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = rollbackSchema.safeParse({
    environmentId: formData.get("environmentId"),
    buildId: formData.get("buildId"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  try {
    await rollbackEnvironment(await headers(), parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "The rollback did not run.") };
  }

  revalidateEnvironment(parsed.data.environmentId);
  return {
    error: null,
    notice: "Rolled back. The new containers take a minute to come up.",
  };
}

export async function destroyEnvironmentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = destroySchema.safeParse({
    environmentId: formData.get("environmentId"),
    confirm: String(formData.get("confirm") ?? "").trim(),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  let result: Awaited<ReturnType<typeof destroyEnvironment>>;
  try {
    result = await destroyEnvironment(await headers(), parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "The environment was not destroyed.") };
  }

  revalidateEnvironment(parsed.data.environmentId);
  // A step failure is not thrown — the stack is parked in `error` and the
  // destroy is resumable — so the outcome has to be read off the result.
  if (result.status === "error") {
    return {
      error: `Destroy stopped at "${result.failedStep}": ${result.error}. Retry from the dashboard.`,
    };
  }
  return { error: null, notice: "Environment destroyed." };
}

export async function retryProvisioningAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = environmentSchema.safeParse({
    environmentId: formData.get("environmentId"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  try {
    await retryEnvironmentProvisioning(await headers(), parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "Provisioning was not restarted.") };
  }

  revalidateEnvironment(parsed.data.environmentId);
  // Deliberately not "provisioned": the enqueue is what just happened, and the
  // pipeline runs after this response. The status chip is the answer.
  return { error: null, notice: "Provisioning restarted." };
}

/**
 * `production` is absent from the form and from this schema: an organization's
 * production environment is created with the organization, and the service
 * refuses a second one.
 */
const createSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter a name for the environment.")
    .max(63, "An environment name is at most 63 characters.")
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "Use lowercase letters, numbers and dashes, starting with a letter or number.",
    ),
  kind: z.enum(["staging", "test"], { message: "Choose staging or test." }),
});

export async function createEnvironmentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = createSchema.safeParse({
    name: formData.get("name"),
    kind: formData.get("kind"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  let created: Awaited<ReturnType<typeof createEnvironment>>;
  try {
    created = await createEnvironment(await headers(), parsed.data);
  } catch (error) {
    // The plan allowance and the name rule arrive here as CloudServiceError
    // and are printed verbatim — they already name the limit and the count.
    return { error: messageFrom(error, "The environment was not created.") };
  }

  revalidateEnvironment(created.environment.id);
  return {
    error: null,
    notice: `Environment "${created.environment.name}" created; provisioning started.`,
  };
}

/**
 * Issue a new publish token, retiring the current one.
 *
 * The only action here that returns a SECRET. It rides back in the action state
 * and nowhere else: the row stores a sha256, so this response is the single
 * moment the token exists outside the machine that will use it. Nothing is
 * revalidated beyond the environment's own page — a router refresh would
 * discard the state the secret is carried in.
 */
export async function rotatePublishTokenAction(
  _previous: PublishTokenState,
  formData: FormData,
): Promise<PublishTokenState> {
  const parsed = environmentSchema.safeParse({
    environmentId: formData.get("environmentId"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Check the form.",
      token: null,
    };
  }

  let issued: Awaited<ReturnType<typeof rotatePublishToken>>;
  try {
    issued = await rotatePublishToken(await headers(), parsed.data);
  } catch (error) {
    return {
      error: messageFrom(error, "The publish token was not rotated."),
      token: null,
    };
  }

  return {
    error: null,
    notice: "New publish token issued. The previous one no longer works.",
    token: issued.token,
  };
}

/**
 * The four tenant-instance actions on the environment page: reveal the Studio
 * password, reveal the `.env` snippet, mint a key, revoke a key.
 *
 * Adapters, like everything above. The tenancy scope, the operator-role gate,
 * the readiness check, the audit write and the control-plane-key refusal all
 * live in `src/lib/tenant-access.ts`, and `tenantErrorMessage` turns a tenant
 * instance that did not answer into a sentence rather than a stack trace.
 *
 * NOTHING here revalidates on a reveal: a router refresh would discard the
 * action state the secret is carried in, and the page has not changed anyway.
 */

const keyIdSchema = environmentSchema.extend({
  keyId: z.string().min(1, "No key was named."),
});

const keyNameSchema = environmentSchema.extend({
  name: z
    .string()
    .trim()
    .min(1, "Give the key a name.")
    .max(64, "A key name is at most 64 characters."),
});

export async function revealStudioPasswordAction(
  _previous: SecretRevealState,
  formData: FormData,
): Promise<SecretRevealState> {
  const parsed = environmentSchema.safeParse({
    environmentId: formData.get("environmentId"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Check the form.",
      value: null,
    };
  }

  try {
    const revealed = await revealStudioPassword(await headers(), parsed.data);
    return {
      error: null,
      notice: `Sign in as ${revealed.email}.`,
      value: revealed.password,
    };
  } catch (error) {
    return { error: tenantErrorMessage(error), value: null };
  }
}

export async function revealIngestSnippetAction(
  _previous: SecretRevealState,
  formData: FormData,
): Promise<SecretRevealState> {
  const parsed = environmentSchema.safeParse({
    environmentId: formData.get("environmentId"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Check the form.",
      value: null,
    };
  }

  try {
    const revealed = await revealIngestSnippet(await headers(), parsed.data);
    return { error: null, notice: null, value: revealed.snippet };
  } catch (error) {
    return { error: tenantErrorMessage(error), value: null };
  }
}

export async function createTenantKeyAction(
  _previous: SecretRevealState,
  formData: FormData,
): Promise<SecretRevealState> {
  const parsed = keyNameSchema.safeParse({
    environmentId: formData.get("environmentId"),
    name: formData.get("name"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Check the form.",
      value: null,
    };
  }

  try {
    const created = await createTenantKey(await headers(), parsed.data);
    revalidateEnvironment(parsed.data.environmentId);
    return {
      error: null,
      notice: `Key "${parsed.data.name}" created.`,
      value: created.key,
    };
  } catch (error) {
    return { error: tenantErrorMessage(error), value: null };
  }
}

export async function revokeTenantKeyAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = keyIdSchema.safeParse({
    environmentId: formData.get("environmentId"),
    keyId: formData.get("keyId"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  try {
    await revokeTenantKey(await headers(), parsed.data);
  } catch (error) {
    return { error: tenantErrorMessage(error) };
  }

  revalidateEnvironment(parsed.data.environmentId);
  return { error: null, notice: "Key revoked. It stops working immediately." };
}
