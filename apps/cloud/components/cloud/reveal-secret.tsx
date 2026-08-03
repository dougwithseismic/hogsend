"use client";

import type { JSX, ReactNode } from "react";
import { useActionState } from "react";
import { Button } from "@/components/ds/button";
import { FormError } from "@/components/ds/field";
import {
  EMPTY_SECRET_REVEAL_STATE,
  type SecretRevealFormAction,
} from "@/src/lib/action-state";
import { CopyValue } from "./copy-value";

/**
 * A secret that is hidden until the caller asks for it.
 *
 * The value is never in the page's HTML: it exists only after the server
 * action runs and only inside this component's action state, so a page render,
 * a screenshot of the dashboard and a browser back-navigation all show the
 * hidden form again.
 *
 * The click is what the audit row records. The action re-checks the caller's
 * organization and role server-side — `canReveal` only decides whether this
 * control is drawn at all.
 */
export function RevealSecret({
  action,
  environmentId,
  revealLabel,
  pendingLabel,
  copyLabel,
  /** Rendered next to the value once it is on screen — the "now change it" line. */
  warning,
  /** Multi-line secrets (the `.env` fragment) get a block, not an inline span. */
  block = false,
}: {
  action: SecretRevealFormAction;
  environmentId: string;
  revealLabel: string;
  pendingLabel: string;
  copyLabel: string;
  warning?: ReactNode;
  block?: boolean;
}): JSX.Element {
  const [state, formAction, pending] = useActionState(
    action,
    EMPTY_SECRET_REVEAL_STATE,
  );

  return (
    <div className="flex flex-col gap-3">
      {state.value ? null : (
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="environmentId" value={environmentId} />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="outline" disabled={pending}>
              {pending ? pendingLabel : revealLabel}
            </Button>
          </div>
          <FormError>{state.error}</FormError>
        </form>
      )}

      {state.value ? (
        <div className="flex flex-col gap-3 rounded-md border border-accent/30 bg-accent-tint p-4">
          {state.notice ? (
            <p className="font-medium text-sm text-white tracking-[-0.02em]">
              {state.notice}
            </p>
          ) : null}
          {block ? (
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-sm text-white/80 leading-6">
              {state.value}
            </pre>
          ) : null}
          <CopyValue value={state.value} label={copyLabel} buttonOnly={block} />
          {warning ? (
            <div className="max-w-prose text-sm text-white/70 leading-6">
              {warning}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
