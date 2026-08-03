"use client";

import type { JSX } from "react";
import { useActionState } from "react";
import { CliCodeInput } from "@/components/cloud/cli-code-input";
import { Button } from "@/components/ds/button";
import { Field, FormError } from "@/components/ds/field";
import { EMPTY_ACTION_STATE, type FormAction } from "@/src/lib/action-state";

/**
 * The one control on the CLI approve page: the code, the confirmation, and the
 * two verbs.
 *
 * The code renders as eight boxes and MAY arrive prefilled from `?code=` —
 * that link is minted by `hogsend login` for this machine's own browser, so
 * prefilling it costs the human nothing they were protecting. The guard
 * against a FORWARDED link (a stranger's pending login sent to a signed-in
 * victim, RFC 8628 §5.4) is the confirmation below: an explicit "I started
 * this login myself", `required` here for the sake of a clear form and
 * REFUSED again on the server — a checkbox is markup, and markup gates
 * nothing. The label the page shows came from the requesting machine and can
 * say anything, so it can never stand in for that confirmation.
 *
 * Approve and Deny are two submit buttons over ONE form, so there is exactly
 * one code on screen and no way to approve one code while reading another. The
 * clicked button posts `decision`.
 */
export function CliApproveForm({
  action,
  initialCode,
}: {
  action: FormAction;
  /** From `?code=` when the CLI opened this page. */
  initialCode?: string;
}): JSX.Element {
  const [state, formAction, pending] = useActionState(
    action,
    EMPTY_ACTION_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <Field
        htmlFor="cli-user-code-0"
        label="Code from the terminal"
        hint="Eight characters, shown as XXXX-XXXX. Paste the whole code into any box; case and spacing do not matter."
      >
        <CliCodeInput initialCode={initialCode} />
      </Field>

      <label
        htmlFor="cli-confirm"
        className="flex max-w-prose items-start gap-3 text-sm text-white/70 leading-6"
      >
        <input
          id="cli-confirm"
          name="confirmed"
          type="checkbox"
          value="yes"
          required
          className="mt-1 size-4 shrink-0 accent-white"
        />
        <span>
          I started this login myself, on a machine I control, and this code is
          the one that machine printed. Approving grants it publish rights in
          this organization.
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          name="decision"
          value="approve"
          variant="solid"
          disabled={pending}
        >
          {pending ? "Working…" : "Approve"}
        </Button>
        {/* Deny skips the browser's validation: refusing a login you did NOT
            start must never require ticking a box that says you did. The
            server still parses the code. */}
        <Button
          type="submit"
          name="decision"
          value="deny"
          variant="outline"
          formNoValidate
          disabled={pending}
        >
          Deny
        </Button>
        {state.notice ? (
          <span className="text-sm text-white/60">{state.notice}</span>
        ) : null}
      </div>

      <FormError>{state.error}</FormError>
    </form>
  );
}
