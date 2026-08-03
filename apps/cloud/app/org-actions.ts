"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/src/lib/auth";

/**
 * Switch which organization the session is looking at.
 *
 * Better Auth's `setActiveOrganization` checks membership itself, so an id
 * posted for an organization the user does not belong to is refused there
 * rather than trusted here. The whole layout is revalidated because the org
 * name, the environments list and the settings page all read from the session's
 * active organization.
 */
export async function setActiveOrganizationAction(
  formData: FormData,
): Promise<void> {
  const organizationId = formData.get("organizationId");
  if (typeof organizationId !== "string" || organizationId.length === 0) return;

  await auth.api.setActiveOrganization({
    body: { organizationId },
    headers: await headers(),
  });

  revalidatePath("/", "layout");
}
