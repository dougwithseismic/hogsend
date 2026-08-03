import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { ProvidersSection } from "@/components/cloud/providers-section";
import { Section } from "@/components/ds/section";
import { PageHeader } from "@/components/shell/page-header";
import { readProvidersView } from "@/src/lib/provider-keys-ops";
import { requireActiveOrganization } from "@/src/lib/session";

export const metadata: Metadata = {
  title: "Add your provider keys",
  description:
    "Connect the email, analytics and SMS accounts your instance sends through.",
};

type PageProps = {
  /** `?env=` selects which environment is being set up. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * The step signup lands on after an organization is created.
 *
 * It is the SAME section the settings page renders — one surface, one set of
 * rules — with an onboarding frame around it. Nothing here is required: an
 * instance provisions and runs with no credentials at all, it simply cannot
 * send. The skip link says exactly that rather than implying a penalty.
 */
export default async function SetupProvidersPage({ searchParams }: PageProps) {
  await requireActiveOrganization();
  const rawEnv = (await searchParams).env;
  const view = await readProvidersView(await headers(), {
    environmentId: Array.isArray(rawEnv) ? rawEnv[0] : rawEnv,
  });

  return (
    <main className="flex flex-1 flex-col">
      <PageHeader
        title="Add your provider keys"
        description="Your production environment is provisioning. It sends nothing until a provider key is stored here — each one is checked against the provider before it is accepted, and you can add them later from Settings."
      />

      <ProvidersSection
        view={view}
        basePath="/setup/providers"
        divider={false}
      />

      <Section containerClassName="flex flex-col gap-3">
        <Link
          href="/"
          className="text-sm text-white/60 underline underline-offset-4 transition-colors hover:text-white"
        >
          Skip for now — email stays inert until a key arrives
        </Link>
        <p className="text-sm text-white/40 leading-6">
          Settings → Providers has the same forms whenever you come back.
        </p>
      </Section>
    </main>
  );
}
