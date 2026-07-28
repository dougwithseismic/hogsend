"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import type { ActionState } from "@/src/lib/action-state";
import {
  ConfirmationMismatchError,
  destroyEnvironment,
  resumeEnvironment,
  suspendEnvironment,
} from "@/src/lib/environment-ops";
import { NotPermittedError } from "@/src/lib/org-members";
import {
  CloudServiceError,
  IllegalTransitionError,
} from "@/src/services/errors";

/**
 * The three environment operations, as server actions.
 *
 * Each one is an adapter and nothing more: parse the form, call the enforced
 * mutation in `src/lib/environment-ops.ts`, turn a refusal into a line the form
 * can print. Every rule — the owner/admin gate, the tenancy scope, the destroy
 * confirmation, the legal-edge table — is checked BELOW this file, because
 * these are POST endpoints anyone with a session can reach and a disabled
 * button is not a permission check.
 *
 * No UI ships with them (PRD 04 task 6 builds the controls); they are wired
 * here so the enforcement and its tests land with the pipeline that does the
 * work rather than a task later.
 */

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

  revalidatePath("/environments");
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

  revalidatePath("/environments");
  return { error: null, notice: "Environment resumed." };
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

  revalidatePath("/environments");
  // A step failure is not thrown — the stack is parked in `error` and the
  // destroy is resumable — so the outcome has to be read off the result.
  if (result.status === "error") {
    return {
      error: `Destroy stopped at "${result.failedStep}": ${result.error}. Retry from the dashboard.`,
    };
  }
  return { error: null, notice: "Environment destroyed." };
}
