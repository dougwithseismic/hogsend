import { readSessionContext } from "@/src/lib/session";
import { OrgSwitcherSelect } from "./org-switcher-select";

/**
 * Renders NOTHING unless there is a choice to make: one organization (the
 * common case) needs no picker, and a control with a single option is a control
 * that lies about what it does.
 */
export async function OrgSwitcher() {
  const context = await readSessionContext();
  if (!context || context.organizations.length < 2) return null;

  const active =
    context.organizations.find(
      (org) => org.id === context.activeOrganizationId,
    ) ?? context.organizations[0];
  if (!active) return null;

  return (
    <OrgSwitcherSelect
      organizations={context.organizations}
      activeId={active.id}
    />
  );
}
