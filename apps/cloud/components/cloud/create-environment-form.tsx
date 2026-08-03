import type { JSX } from "react";
import { createEnvironmentAction } from "@/app/environments/actions";
import { Card } from "@/components/ds/card";
import { Field, Input } from "@/components/ds/field";
import { ActionForm, Select } from "./action-form";

/**
 * Create an environment, and start provisioning it.
 *
 * `production` is not offered: it is created with the organization and the
 * service refuses a second one, so a third option here would be a control that
 * always fails.
 *
 * The plan allowance is NOT pre-checked into a disabled button. It is counted
 * inside the creating transaction (two tabs cannot both pass a stale count),
 * and the refusal it raises names the limit and the current total — which is
 * more use than a greyed-out form. The caller's role IS pre-checked, because a
 * member's create would fail for a reason they cannot fix from here.
 */
export function CreateEnvironmentForm({
  plan,
  limit,
  used,
}: {
  plan: string;
  limit: number;
  used: number;
}): JSX.Element {
  return (
    <Card className="flex scroll-mt-8 flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 className="font-medium text-sm text-white tracking-[-0.02em]">
          New environment
        </h2>
        <p className="max-w-prose text-sm text-white/60 leading-6">
          Creating an environment reserves a database name and a Hatchet
          namespace, then starts provisioning immediately — no operator step.
          The {plan} plan allows {limit}; {used} in use.
        </p>
      </div>

      <ActionForm
        action={createEnvironmentAction}
        submitLabel="Create environment"
        pendingLabel="Creating…"
        variant="solid"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <Field
            htmlFor="environment-name"
            label="Name"
            hint="Lowercase letters, numbers and dashes. Unique within this organization."
            className="flex-1"
          >
            <Input
              id="environment-name"
              name="name"
              autoComplete="off"
              placeholder="staging"
              required
            />
          </Field>
          <Field
            htmlFor="environment-kind"
            label="Kind"
            hint="Test environments run the engine in test mode."
            className="sm:w-48"
          >
            <Select id="environment-kind" name="kind" defaultValue="staging">
              <option value="staging">staging</option>
              <option value="test">test</option>
            </Select>
          </Field>
        </div>
      </ActionForm>
    </Card>
  );
}
