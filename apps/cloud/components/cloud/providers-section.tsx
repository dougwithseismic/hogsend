import Link from "next/link";
import type { JSX } from "react";
import { TagPill } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import { Section, SectionHeading } from "@/components/ds/section";
import {
  proofLabel,
  proofSentence,
  proofTone,
  providerLabel,
} from "@/src/lib/provider-catalog";
import type {
  ProviderKeyState,
  ProvidersView,
} from "@/src/lib/provider-keys-ops";
import { SENDER_IDENTITY_PROVIDER } from "@/src/services/provider-env";
import {
  ProviderKeyForm,
  ProviderRemoveForm,
  SenderIdentityForm,
} from "./provider-key-form";

/**
 * The provider credentials for ONE environment: what is configured, how well
 * it is proven, and (for an owner or admin) the controls that change it.
 *
 * Two copy laws hold everywhere below:
 *  - Only a credential a provider actually answered about is called
 *    "verified"; everything else says what it really is.
 *  - No stored value is ever rendered — `last4` is the whole of it.
 *
 * `view.canManage` decides what renders; it enforces nothing. Every action in
 * `app/settings/provider-actions.ts` re-resolves the caller's role server-side.
 */

function StateChip({ state }: { state: ProviderKeyState }): JSX.Element {
  if (!state.configured || !state.proof) {
    return <TagPill tone="neutral">not configured</TagPill>;
  }
  return (
    <TagPill tone={proofTone(state.proof)}>{proofLabel(state.proof)}</TagPill>
  );
}

function StateLine({ state }: { state: ProviderKeyState }): JSX.Element {
  if (!state.configured || !state.proof) {
    return (
      <p className="text-sm text-white/50 leading-6">
        No credential stored. This environment runs without it.
      </p>
    );
  }
  return (
    <p className="text-sm text-white/60 leading-6">
      {state.last4 ? `Ends ${state.last4}. ` : ""}
      {proofSentence(state.provider, state.proof, state.verifiedAt)}
    </p>
  );
}

function EnvironmentPicker({
  view,
  basePath,
}: {
  view: ProvidersView;
  basePath: string;
}): JSX.Element | null {
  if (view.environments.length < 2 || !view.selected) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-white/50">Environment</span>
      {view.environments.map((option) => {
        const active = option.id === view.selected?.id;
        return (
          <Link
            key={option.id}
            href={`${basePath}?env=${option.id}`}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "rounded-[3px] border border-accent bg-accent-tint px-2 py-1 text-white text-xs"
                : "rounded-[3px] border border-white/[0.08] bg-white/[0.06] px-2 py-1 text-white/70 text-xs hover:text-white"
            }
          >
            {option.name}
          </Link>
        );
      })}
    </div>
  );
}

export function ProvidersSection({
  view,
  basePath,
  divider = true,
}: {
  view: ProvidersView;
  /** Where the environment picker's links point — this surface's own path. */
  basePath: string;
  divider?: boolean;
}): JSX.Element {
  const { selected, canManage } = view;

  return (
    <Section
      id="providers"
      divider={divider}
      containerClassName="flex flex-col gap-5"
    >
      <SectionHeading
        eyebrow="Providers"
        title="The keys your instance sends with"
        subtitle={
          canManage
            ? "Each key is checked against its provider before it is stored; a key that fails stores nothing. Saving one updates a running instance and restarts it."
            : "Your role is member: you can see which providers are configured. Adding and removing keys is an owner or admin action."
        }
      />

      <EnvironmentPicker view={view} basePath={basePath} />

      {selected ? (
        <p className="text-sm text-white/50 leading-6">
          Showing <span className="text-white/80">{selected.name}</span> (
          {selected.kind}
          {selected.stackStatus ? `, stack ${selected.stackStatus}` : ""}).
          Credentials are per environment — nothing here is shared between them.
        </p>
      ) : (
        <p className="text-sm text-white/50 leading-6">
          This organization has no environments, so there is nothing to
          configure yet.
        </p>
      )}

      {selected ? (
        <>
          <Card className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-medium text-base text-white tracking-[-0.02em]">
                {providerLabel(SENDER_IDENTITY_PROVIDER)}
              </h3>
              <StateChip state={view.sender} />
            </div>
            <p className="text-sm text-white/60 leading-6">
              The address your instance sends from. Until one is set, mail
              leaves from the engine's default address.
            </p>
            <StateLine state={view.sender} />
            {canManage ? (
              <SenderIdentityForm
                environmentId={selected.id}
                disabled={view.sender.checkedBy === null}
              />
            ) : null}
          </Card>

          {view.providers.map(({ form, state }) => (
            <Card key={form.id} className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-medium text-base text-white tracking-[-0.02em]">
                  {form.label}
                </h3>
                <StateChip state={state} />
              </div>
              <p className="text-sm text-white/60 leading-6">{form.purpose}</p>
              <StateLine state={state} />

              {canManage ? (
                <ProviderKeyForm
                  environmentId={selected.id}
                  provider={form.id}
                  fields={form.fields}
                  email={form.email}
                  configured={state.configured}
                />
              ) : null}

              {canManage && state.configured ? (
                <ProviderRemoveForm
                  environmentId={selected.id}
                  provider={form.id}
                  label={form.label}
                  inert={form.inert}
                />
              ) : null}
            </Card>
          ))}
        </>
      ) : null}
    </Section>
  );
}
