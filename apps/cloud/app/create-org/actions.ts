"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { provisionOrganization } from "@/src/lib/org-provision";
import { CloudServiceError } from "@/src/services/errors";

/**
 * The create-org form's only entry point. The work itself lives in
 * `provisionOrganization` (testable without a request); this action is the
 * adapter: parse the form, run it, turn a typed service error into a line the
 * form can print, and redirect on success.
 */

export type CreateOrgState = { error: string | null };

const formSchema = z.object({
  name: z.string().trim().min(1, "Enter a name for the organization.").max(200),
  region: z.enum(["us", "eu"], { message: "Choose a region." }),
});

export async function createOrganizationAction(
  _previous: CreateOrgState,
  formData: FormData,
): Promise<CreateOrgState> {
  const parsed = formSchema.safeParse({
    name: formData.get("name"),
    region: formData.get("region"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  try {
    await provisionOrganization({
      name: parsed.data.name,
      region: parsed.data.region,
      // Every signup starts on the trial. Paid plans are informational until
      // billing can charge for them.
      plan: "trial",
      headers: await headers(),
    });
  } catch (error) {
    if (error instanceof CloudServiceError) return { error: error.message };
    console.error("[cloud] Organization creation failed:", error);
    return {
      error: "The organization could not be created. Try again.",
    };
  }

  // Outside the catch: `redirect` signals by throwing, and swallowing it here
  // would turn a successful signup into a generic form error.
  //
  // Straight into the key step rather than the dashboard: the instance being
  // provisioned right now cannot send a single email until a provider key
  // arrives, so asking for one is the honest next screen. It is skippable —
  // the step says so — and skipping lands on the dashboard.
  redirect("/setup/providers");
}
