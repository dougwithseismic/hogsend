"use client";

import { useActionState, useId } from "react";
import {
  type CreateOrgState,
  createOrganizationAction,
} from "@/app/create-org/actions";
import { Button } from "@/components/ds/button";
import { Field, FormError, Input } from "@/components/ds/field";
import { cn } from "@/lib/cn";
import type { RegionOption } from "@/src/lib/regions";

const INITIAL: CreateOrgState = { error: null };

export function CreateOrgForm({
  regions,
  hasDrainedRegions,
}: {
  /** Regions with an accepting cell — the only ones that can take a tenant. */
  regions: RegionOption[];
  /** True when a known region is not on offer, so the note names a real gap. */
  hasDrainedRegions: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    createOrganizationAction,
    INITIAL,
  );
  const nameId = useId();

  if (regions.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <FormError>
          No region is accepting new organizations right now.
        </FormError>
        <p className="text-sm text-white/60 leading-6">
          Every region's shared capacity is drained. Email support@hogsend.com
          and we will place your account by hand.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-8">
      <FormError>{state.error}</FormError>

      <Field
        htmlFor={nameId}
        label="Organization name"
        hint="What your team is called. It appears across the dashboard and can be changed later."
      >
        <Input id={nameId} name="name" required maxLength={200} />
      </Field>

      <fieldset className="flex flex-col gap-3">
        <legend className="font-medium text-sm text-white/80 tracking-[-0.02em]">
          Region
        </legend>
        <p className="text-white/40 text-xs leading-5">
          Where this organization's data lives. Fixed once the organization
          exists.
        </p>
        <div className="mt-1 grid gap-3 sm:grid-cols-2">
          {regions.map((region, index) => (
            <label
              key={region.id}
              className={cn(
                "group flex cursor-pointer items-start gap-3 rounded-md border border-white/[0.08] bg-white/[0.015] p-4",
                "transition-colors duration-200 hover:border-white/15",
                "has-[:checked]:border-accent has-[:checked]:bg-accent-tint",
              )}
            >
              <input
                type="radio"
                name="region"
                value={region.id}
                defaultChecked={index === 0}
                required
                className="mt-1 size-3.5 accent-accent"
              />
              <span className="flex flex-col gap-1">
                <span className="font-medium text-sm text-white tracking-[-0.02em]">
                  {region.label}
                </span>
                <span className="text-white/50 text-xs leading-5">
                  {region.detail}
                </span>
              </span>
            </label>
          ))}
        </div>
        {hasDrainedRegions ? (
          <p className="text-white/40 text-xs leading-5">
            Regions missing from this list have no shared capacity accepting new
            organizations. A dedicated plan runs on its own infrastructure and
            can be placed in any region.
          </p>
        ) : null}
      </fieldset>

      <Button
        type="submit"
        disabled={pending}
        className="w-full justify-center sm:w-auto sm:self-start sm:px-6"
      >
        {pending ? "Creating organization…" : "Create organization"}
      </Button>
    </form>
  );
}
