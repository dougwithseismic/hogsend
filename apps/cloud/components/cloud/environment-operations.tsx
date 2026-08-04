import type { JSX } from "react";
import {
  destroyEnvironmentAction,
  resumeEnvironmentAction,
  retryProvisioningAction,
  suspendEnvironmentAction,
} from "@/app/environments/actions";
import { Hairline } from "@/components/ds/decor";
import type { EnvironmentOperation } from "@/src/lib/environment-ops";
import { ActionForm } from "./action-form";
import { DestroyEnvironmentForm } from "./destroy-environment-form";

/**
 * The operations card: exactly the controls this caller can run on this stack
 * right now, and nothing else.
 *
 * The set comes from `allowedOperations(role, status)` — one pure function,
 * shared with the tests — so there is no control here that the server would
 * refuse, and no legal operation without a control. A caller whose role or
 * whose stack status admits nothing sees the reason in a sentence rather than a
 * row of greyed-out buttons.
 */

const EXPLANATION: Record<string, string> = {
  provisioning:
    "The pipeline is working on this stack. Suspend, destroy and retry become available when it finishes or fails.",
  publishing:
    "A publish is in flight. Operations become available when it finishes or fails.",
  destroying: "The teardown is running.",
  destroyed:
    "This stack is destroyed. A new stack is a new environment; this row is kept for its history.",
};

export function EnvironmentOperations({
  environmentId,
  environmentName,
  status,
  allowed,
  canOperate,
}: {
  environmentId: string;
  environmentName: string;
  status: string | null;
  allowed: EnvironmentOperation[];
  /** False for a `member`: they may read an environment, not operate it. */
  canOperate: boolean;
}): JSX.Element {
  const hidden = { environmentId };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-5">
        {allowed.includes("retry") ? (
          <ActionForm
            action={retryProvisioningAction}
            hidden={hidden}
            submitLabel={
              status === "error" ? "Retry provisioning" : "Start provisioning"
            }
            pendingLabel="Enqueueing…"
          >
            <p className="max-w-prose text-sm text-white/60 leading-6">
              Re-runs the pipeline for this stack. Steps that already left an
              artifact — the tenant database, the Hatchet token, the substrate
              services — are skipped, so it resumes rather than rebuilds.
            </p>
          </ActionForm>
        ) : null}

        {allowed.includes("suspend") ? (
          <ActionForm
            action={suspendEnvironmentAction}
            hidden={hidden}
            submitLabel="Suspend"
            pendingLabel="Suspending…"
          >
            <p className="max-w-prose text-sm text-white/60 leading-6">
              Stops the substrate services. The tenant database and every stored
              credential are kept, and resume brings the same stack back.
            </p>
          </ActionForm>
        ) : null}

        {allowed.includes("resume") ? (
          <ActionForm
            action={resumeEnvironmentAction}
            hidden={hidden}
            submitLabel="Resume"
            pendingLabel="Resuming…"
          >
            <p className="max-w-prose text-sm text-white/60 leading-6">
              Starts the substrate services again and returns the stack to
              running.
            </p>
          </ActionForm>
        ) : null}

        {allowed.includes("destroy") ? (
          <DestroyEnvironmentForm
            action={destroyEnvironmentAction}
            environmentId={environmentId}
            environmentName={environmentName}
          />
        ) : null}

        {allowed.length === 0 ? (
          <p className="max-w-prose text-sm text-white/60 leading-6">
            {canOperate
              ? (EXPLANATION[status ?? ""] ??
                "There is nothing to operate: this environment has no stack.")
              : "Your role in this organization is member, so you can read this environment but not suspend, resume or destroy it."}
          </p>
        ) : null}
      </div>
    </div>
  );
}
