"use client";

import { useRef } from "react";
import { setActiveOrganizationAction } from "@/app/org-actions";
import type { OrganizationSummary } from "@/src/lib/session-guard";

/**
 * The rail's organization picker. Changing the select submits the form, so the
 * switch happens in one gesture; the submit button stays in the markup (visible
 * only to assistive tech and to a browser without JS) so the control still
 * works when `onChange` cannot fire.
 */
export function OrgSwitcherSelect({
  organizations,
  activeId,
}: {
  organizations: OrganizationSummary[];
  activeId: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form ref={formRef} action={setActiveOrganizationAction}>
      <label className="flex flex-col gap-1.5 px-2">
        <span className="eyebrow text-white/40">Organization</span>
        <select
          // Keyed by the active org: the value is UNCONTROLLED, so after a
          // switch React would reuse the existing <select> and the DOM would
          // keep showing the organization we just navigated away from. A
          // changed key remounts it against the server's answer.
          key={activeId}
          name="organizationId"
          defaultValue={activeId}
          onChange={() => formRef.current?.requestSubmit()}
          className="h-9 w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-2 text-sm text-white tracking-[-0.02em] outline-none transition-colors hover:border-white/20 focus:border-accent"
        >
          {organizations.map((org) => (
            <option key={org.id} value={org.id} className="bg-ink-raised">
              {org.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="sr-only">
        Switch organization
      </button>
    </form>
  );
}
