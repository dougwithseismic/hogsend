"use client";

import { Eye, EyeOff } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { useActionState, useState } from "react";
import { Button } from "@/components/ds/button";
import { FormError } from "@/components/ds/field";
import { cn } from "@/lib/cn";
import {
  EMPTY_SECRET_REVEAL_STATE,
  type SecretRevealFormAction,
} from "@/src/lib/action-state";
import { CopyValue } from "./copy-value";

/**
 * A secret that is hidden until the caller asks for it, and can be hidden
 * again afterwards.
 *
 * The value is never in the page's HTML: it exists only after the server
 * action runs and only inside this component's action state, so a page render,
 * a screenshot of the dashboard and a browser back-navigation all show the
 * hidden form again.
 *
 * Once revealed it renders as a masked field with an eye toggle, so a customer
 * who has read it can put it back behind dots without reloading the page. The
 * toggle is a VIEW control only — it is not a second security boundary. After
 * the action returns, the value is in this component's state and therefore in
 * the live DOM either way; masking defeats a shoulder and a screen share, not a
 * devtools reader. The boundary that matters is the one above: the value only
 * ever arrives as the return of an explicitly clicked action.
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
  /** Multi-line secrets (the `.env` fragment) get a block, not an inline field. */
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
  // Shown on arrival: the customer just clicked to read it. The toggle is what
  // lets them put it back.
  const [shown, setShown] = useState(true);

  if (!state.value) {
    return (
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="environmentId" value={environmentId} />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? pendingLabel : revealLabel}
          </Button>
        </div>
        <FormError>{state.error}</FormError>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-accent/30 bg-accent-tint p-4">
      {state.notice ? (
        <p className="font-medium text-sm text-white tracking-[-0.02em]">
          {state.notice}
        </p>
      ) : null}

      <div className={cn("flex gap-2", block ? "flex-col" : "items-center")}>
        {block ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-sm text-white/80 leading-6">
            {shown ? state.value : maskBlock(state.value)}
          </pre>
        ) : (
          <input
            readOnly
            type={shown ? "text" : "password"}
            value={state.value}
            aria-label={copyLabel}
            className="min-w-0 flex-1 rounded-md border border-white/[0.08] bg-black/20 px-3 py-2 font-mono text-sm text-white/80 outline-none"
          />
        )}
        <div className={cn("flex items-center gap-2", block ? "" : "shrink-0")}>
          <ToggleButton
            shown={shown}
            label={copyLabel}
            onToggle={() => setShown((value) => !value)}
          />
          <CopyValue value={state.value} label={copyLabel} buttonOnly />
        </div>
      </div>

      {warning ? (
        <div className="max-w-prose text-sm text-white/70 leading-6">
          {warning}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The mask for a multi-line secret. A `<textarea>` cannot be `type="password"`,
 * so the dots are drawn rather than native. Every line becomes the same fixed
 * run of dots: the character counts are not leaked, and the line count — which
 * is only "how many variables" — is kept so the block does not jump size when
 * the eye is flipped.
 */
function maskBlock(value: string): string {
  return value
    .split("\n")
    .map(() => "•".repeat(28))
    .join("\n");
}

function ToggleButton({
  shown,
  label,
  onToggle,
}: {
  shown: boolean;
  label: string;
  onToggle: () => void;
}): JSX.Element {
  const Icon = shown ? EyeOff : Eye;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={shown}
      aria-label={shown ? `Hide ${label}` : `Show ${label}`}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-white/[0.08] text-white/60 transition-colors hover:border-white/20 hover:text-white"
    >
      <Icon aria-hidden className="size-3.5" strokeWidth={1.75} />
    </button>
  );
}
