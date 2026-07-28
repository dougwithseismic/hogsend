"use client";

import type { JSX } from "react";
import {
  removeProviderKeyAction,
  saveProviderKeyAction,
  saveSenderIdentityAction,
} from "@/app/settings/provider-actions";
import { Field, Input } from "@/components/ds/field";
import type { ProviderField } from "@/src/lib/provider-catalog";
import { ActionForm } from "./action-form";

/**
 * The three credential controls, as client forms.
 *
 * They are dumb on purpose: every field they render arrives as a prop from the
 * server (the catalog is the single source of the shape), and every rule —
 * who may submit, whether the key is real, whether the domain is verified —
 * lives in the action and below it. Nothing here validates, and nothing here
 * ever renders a stored value: a rotation asks for the whole credential again,
 * because the control plane cannot show what it holds.
 */

function controlId(provider: string, name: string): string {
  return `provider-${provider}-${name}`;
}

export function ProviderKeyForm({
  environmentId,
  provider,
  fields,
  email,
  configured,
}: {
  environmentId: string;
  provider: string;
  fields: readonly ProviderField[];
  /** Email providers also carry the sending address on first save. */
  email: boolean;
  /** Changes the button's words; a rotation replaces, it does not merge. */
  configured: boolean;
}): JSX.Element {
  return (
    <ActionForm
      action={saveProviderKeyAction}
      hidden={{ environmentId, provider }}
      submitLabel={configured ? "Replace key" : "Save key"}
      pendingLabel="Checking with the provider…"
      variant="solid"
    >
      <div className="flex flex-col gap-4">
        {fields.map((field) => (
          <Field
            key={field.name}
            htmlFor={controlId(provider, field.name)}
            label={field.required ? field.label : `${field.label} (optional)`}
            {...(field.hint ? { hint: field.hint } : {})}
          >
            <Input
              id={controlId(provider, field.name)}
              name={field.name}
              type={field.kind === "secret" ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              required={field.required}
              {...(field.placeholder ? { placeholder: field.placeholder } : {})}
            />
          </Field>
        ))}

        {email ? (
          <Field
            htmlFor={controlId(provider, "fromAddress")}
            label="Sending address (optional)"
            hint="Saved with the key and only accepted when its domain is verified on this provider account."
          >
            <Input
              id={controlId(provider, "fromAddress")}
              name="fromAddress"
              type="email"
              autoComplete="off"
              placeholder="lifecycle@yourdomain.com"
            />
          </Field>
        ) : null}
      </div>
    </ActionForm>
  );
}

/**
 * Removal, behind a disclosure that names what goes inert. The list is the
 * service's (`INERT_ON_REMOVAL`), not a copywriter's — so it cannot drift from
 * what actually stops working.
 */
export function ProviderRemoveForm({
  environmentId,
  provider,
  label,
  inert,
}: {
  environmentId: string;
  provider: string;
  label: string;
  inert: readonly string[];
}): JSX.Element {
  return (
    <details className="rounded-[10px] border border-white/[0.08] px-4 py-3">
      <summary className="cursor-pointer text-sm text-white/60 tracking-[-0.02em] hover:text-white">
        Remove the {label} credential
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <p className="text-sm text-white/60 leading-6">
          {inert.length > 0
            ? "Removing it unsets its environment variables and restarts the instance. These stop working:"
            : "Removing it unsets its environment variables and restarts the instance."}
        </p>
        {inert.length > 0 ? (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-white/60 leading-6">
            {inert.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
        ) : null}
        <ActionForm
          action={removeProviderKeyAction}
          hidden={{ environmentId, provider }}
          submitLabel="Remove"
          pendingLabel="Removing…"
          variant="outline"
        />
      </div>
    </details>
  );
}

/**
 * The sending address on its own. Submitting it replays the stored email key
 * through the provider's domains list, so the address is checked live rather
 * than taken on trust.
 */
export function SenderIdentityForm({
  environmentId,
  disabled,
}: {
  environmentId: string;
  /** True when no email provider is configured yet — there is nothing to check against. */
  disabled: boolean;
}): JSX.Element {
  if (disabled) {
    return (
      <p className="text-sm text-white/50 leading-6">
        Add a Resend or Postmark key first. A sending address is only accepted
        when its domain is verified on the account that will send it.
      </p>
    );
  }

  return (
    <ActionForm
      action={saveSenderIdentityAction}
      hidden={{ environmentId }}
      submitLabel="Save address"
      pendingLabel="Checking the domain…"
      variant="solid"
    >
      <Field
        htmlFor="sender-identity-from"
        label="From address"
        hint="Checked against the verified domains on your email provider account, then synced as EMAIL_FROM and EMAIL_DOMAIN."
      >
        <Input
          id="sender-identity-from"
          name="fromAddress"
          type="email"
          autoComplete="off"
          required
          placeholder="lifecycle@yourdomain.com"
        />
      </Field>
    </ActionForm>
  );
}
