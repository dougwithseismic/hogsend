"use client";

import { type JSX, useActionState, useState } from "react";
import { Button } from "@/components/ds/button";
import { Field, FormError, Input } from "@/components/ds/field";
import { EMPTY_ACTION_STATE, type FormAction } from "@/src/lib/action-state";

/**
 * Destroy, behind the environment's own name.
 *
 * The typed confirmation is checked TWICE on purpose: here, so the button
 * cannot be pressed by accident, and again in `destroyEnvironment` against the
 * name read from the database — because this form is a POST endpoint and a
 * disabled button stops nobody. The two checks are the same rule, not a
 * duplicated one: only the server's is enforcement.
 *
 * The copy names what goes: the substrate services and the tenant database.
 * That is what `destroyStack` actually does, and it does not come back.
 */
export function DestroyEnvironmentForm({
  action,
  environmentId,
  environmentName,
}: {
  action: FormAction;
  environmentId: string;
  environmentName: string;
}): JSX.Element {
  const [state, formAction, pending] = useActionState(
    action,
    EMPTY_ACTION_STATE,
  );
  const [confirm, setConfirm] = useState("");
  const matches = confirm.trim() === environmentName;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="environmentId" value={environmentId} />
      <Field
        htmlFor="destroy-confirm"
        label="Type the environment name"
        hint={`Exactly "${environmentName}". Destroy removes the substrate services and drops the tenant database; it cannot be undone.`}
      >
        <Input
          id="destroy-confirm"
          name="confirm"
          autoComplete="off"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" disabled={!matches || pending}>
          {pending ? "Destroying…" : "Destroy environment"}
        </Button>
        {state.notice ? (
          <span className="text-sm text-white/60">{state.notice}</span>
        ) : null}
      </div>
      <FormError>{state.error}</FormError>
    </form>
  );
}
