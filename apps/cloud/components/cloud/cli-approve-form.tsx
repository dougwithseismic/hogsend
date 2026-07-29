"use client";

import type { JSX } from "react";
import { useActionState } from "react";
import { Button } from "@/components/ds/button";
import { Field, FormError, Input } from "@/components/ds/field";
import { EMPTY_ACTION_STATE, type FormAction } from "@/src/lib/action-state";

/**
 * The one control on the CLI approve page: the code, the confirmation, and the
 * two verbs.
 *
 * The field starts EMPTY and is never prefilled from the URL. That friction is
 * the security property, not an oversight: transcribing the code is the only
 * thing tying the browser that approves to the machine that asked, so a link
 * that filled it in would let a stranger's pending login be bound to whoever
 * opens the link in one click (RFC 8628 §5.4). The label the page shows came
 * from the requesting machine and can say anything, so it cannot stand in.
 *
 * The confirmation is the same rule said out loud. It is `required` here for
 * the sake of a clear form, and REFUSED again on the server — a checkbox is
 * markup, and markup gates nothing.
 *
 * Approve and Deny are two submit buttons over ONE form, so there is exactly
 * one code on screen and no way to approve one code while reading another. The
 * clicked button posts `decision`.
 */
export function CliApproveForm({
  action,
}: {
  action: FormAction;
}): JSX.Element {
  const [state, formAction, pending] = useActionState(
    action,
    EMPTY_ACTION_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <Field
        htmlFor="cli-user-code"
        label="Code from the terminal"
        hint="Eight characters, shown as XXXX-XXXX. Case and spacing do not matter."
      >
        <Input
          id="cli-user-code"
          name="userCode"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="XXXX-XXXX"
          required
          className="font-mono tracking-[0.2em]"
        />
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
