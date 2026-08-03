"use client";

import type { JSX } from "react";
import { useActionState, useState } from "react";
import {
  createTenantKeyAction,
  revokeTenantKeyAction,
} from "@/app/environments/actions";
import { Button } from "@/components/ds/button";
import { FormError, Input } from "@/components/ds/field";
import {
  EMPTY_ACTION_STATE,
  EMPTY_SECRET_REVEAL_STATE,
} from "@/src/lib/action-state";
import { CopyValue } from "./copy-value";

/**
 * Mint a key on the customer's own instance.
 *
 * The full key comes back exactly once and is shown once, and unlike the Studio
 * password that really is one-time: the instance stores only a hash, so there
 * is no read anywhere that could produce it again. The copy says so in the same
 * breath as it shows the key.
 */
export function CreateTenantKeyForm({
  environmentId,
}: {
  environmentId: string;
}): JSX.Element {
  const [state, formAction, pending] = useActionState(
    createTenantKeyAction,
    EMPTY_SECRET_REVEAL_STATE,
  );

  return (
    <div className="flex flex-col gap-3">
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="environmentId" value={environmentId} />
        <div className="flex flex-wrap items-end gap-3">
          <Input
            name="name"
            required
            maxLength={64}
            placeholder="my-app-production"
            aria-label="New key name"
            className="max-w-xs"
          />
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? "Creating…" : "Create key"}
          </Button>
        </div>
        <FormError>{state.error}</FormError>
      </form>

      {state.value ? (
        <div className="flex flex-col gap-3 rounded-md border border-accent/30 bg-accent-tint p-4">
          <p className="font-medium text-sm text-white tracking-[-0.02em]">
            Copy this key now
          </p>
          <p className="max-w-prose text-sm text-white/70 leading-6">
            Your instance stores it hashed, so this is the only time it can be
            read. Lose it and you create another one.
          </p>
          <CopyValue value={state.value} label="API key" />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Revoke, with the confirmation in the control rather than a browser dialog.
 *
 * Two clicks, not a `confirm()`: the second button names what it is about to
 * do, and a mis-click on the first one is undone by walking away. The server
 * refuses the control-plane key regardless — this form only decides which
 * buttons are drawn.
 */
export function RevokeTenantKeyForm({
  environmentId,
  keyId,
  keyName,
}: {
  environmentId: string;
  keyId: string;
  keyName: string;
}): JSX.Element {
  const [state, formAction, pending] = useActionState(
    revokeTenantKeyAction,
    EMPTY_ACTION_STATE,
  );
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="flex flex-col gap-2">
        <Button
          variant="ghost"
          onClick={() => setConfirming(true)}
          type="button"
        >
          Revoke
        </Button>
        {state.notice ? (
          <span className="text-sm text-white/60">{state.notice}</span>
        ) : null}
        <FormError>{state.error}</FormError>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="environmentId" value={environmentId} />
      <input type="hidden" name="keyId" value={keyId} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Revoking…" : `Revoke "${keyName}" for good`}
        </Button>
        <Button
          variant="ghost"
          type="button"
          onClick={() => setConfirming(false)}
        >
          Cancel
        </Button>
      </div>
      <span className="max-w-prose text-sm text-white/60 leading-6">
        Anything still sending with this key starts failing immediately.
      </span>
      <FormError>{state.error}</FormError>
    </form>
  );
}
