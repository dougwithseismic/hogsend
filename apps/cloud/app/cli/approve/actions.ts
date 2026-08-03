"use server";

import { headers } from "next/headers";
import { z } from "zod";
import type { ActionState } from "@/src/lib/action-state";
import {
  approveCliDevice,
  type CliDeviceDecision,
  type CliDeviceRefusal,
  denyCliDevice,
} from "@/src/lib/cli-sessions-ops";
import { NotPermittedError } from "@/src/lib/org-members";

/**
 * Approve or deny one CLI login.
 *
 * An adapter, like every other action in this app: parse the form, call the
 * enforced mutation in `src/lib/cli-sessions-ops.ts` (which resolves the
 * caller's membership from the database), turn a refusal into a line the form
 * can print. The gate is NOT this file and it is not the page — both buttons
 * post to an endpoint anyone with a session can reach, so the rule lives below.
 *
 * One action for two verbs: the clicked button posts `decision`, so approve and
 * deny share one input and there is only ever one code on screen to confuse.
 */

const schema = z.object({
  // Loose on purpose — the SERVICE normalizes case, spacing and the hyphen,
  // and refuses anything outside the code alphabet. Rejecting a shape here
  // would only duplicate that rule badly.
  userCode: z.string().trim().min(1, "Enter the code the CLI printed.").max(64),
  decision: z.enum(["approve", "deny"]),
  // A checkbox posts its value only when it is ticked, so ABSENCE is the
  // unconfirmed case. Parsed permissively and judged below the actions layer:
  // the gate is `approveCliDevice`, not this schema.
  confirmed: z.unknown().transform((value) => typeof value === "string"),
});

/** Every refusal, as a line a human at a terminal can act on. */
function refusalMessage(reason: CliDeviceRefusal) {
  switch (reason) {
    case "not_confirmed":
      return "Tick the confirmation before approving. Approve a login only if you started it yourself.";
    case "not_found":
      return "No pending login has that code. Check it against the one the CLI printed.";
    case "expired":
      return "That code has expired. Run `hogsend login` again for a fresh one.";
    default:
      return "That code has already been approved or denied.";
  }
}

function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof NotPermittedError) return error.message;
  console.error("[cloud] CLI approve action failed:", error);
  return fallback;
}

export async function decideCliDeviceAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = schema.safeParse({
    userCode: formData.get("userCode"),
    decision: formData.get("decision"),
    confirmed: formData.get("confirmed"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  let result: CliDeviceDecision;
  try {
    const requestHeaders = await headers();
    result =
      parsed.data.decision === "approve"
        ? await approveCliDevice(requestHeaders, {
            userCode: parsed.data.userCode,
            confirmed: parsed.data.confirmed,
          })
        : await denyCliDevice(requestHeaders, {
            userCode: parsed.data.userCode,
          });
  } catch (error) {
    return { error: messageFrom(error, "The code could not be processed.") };
  }

  if (!result.ok) return { error: refusalMessage(result.reason) };

  return {
    error: null,
    notice:
      parsed.data.decision === "approve"
        ? `Approved ${result.request.userCode}. The CLI can finish signing in; you can close this page.`
        : `Denied ${result.request.userCode}. The CLI will stop waiting.`,
  };
}
