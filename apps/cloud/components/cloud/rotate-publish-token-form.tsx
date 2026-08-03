"use client";

import type { JSX } from "react";
import { useActionState } from "react";
import { Button } from "@/components/ds/button";
import { FormError } from "@/components/ds/field";
import {
  EMPTY_PUBLISH_TOKEN_STATE,
  type PublishTokenFormAction,
} from "@/src/lib/action-state";
import { CopyValue } from "./copy-value";

/**
 * The rotate control, and the one place a publish token is ever readable.
 *
 * The secret lives in this component's action state and nowhere else: the row
 * stores a sha256, so there is no read that could show it again. That is why
 * the panel below says so in the same breath as it shows the token — a customer
 * who closes the page without copying it has to rotate again, and should learn
 * that from the UI rather than from a support thread.
 *
 * The action re-checks the caller's role server-side. `canRotate` only decides
 * whether the control is drawn.
 */
export function RotatePublishTokenForm({
  action,
  environmentId,
}: {
  action: PublishTokenFormAction;
  environmentId: string;
}): JSX.Element {
  const [state, formAction, pending] = useActionState(
    action,
    EMPTY_PUBLISH_TOKEN_STATE,
  );

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="environmentId" value={environmentId} />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? "Issuing…" : "Rotate publish token"}
          </Button>
          <span className="text-sm text-white/60">
            The current token stops working the moment a new one is issued.
          </span>
        </div>
        <FormError>{state.error}</FormError>
      </form>

      {state.token ? (
        <div className="flex flex-col gap-3 rounded-md border border-accent/30 bg-accent-tint p-4">
          <p className="font-medium text-sm text-white tracking-[-0.02em]">
            Copy this token now
          </p>
          <p className="max-w-prose text-sm text-white/70 leading-6">
            It is stored hashed, so this is the only time it can be read. Put it
            in the machine that runs <code className="font-mono">hogsend</code>{" "}
            <code className="font-mono">publish</code> as{" "}
            <code className="font-mono">HOGSEND_PUBLISH_TOKEN</code>. Lose it
            and you rotate again.
          </p>
          <CopyValue value={state.token} label="publish token" />
        </div>
      ) : null}
    </div>
  );
}
