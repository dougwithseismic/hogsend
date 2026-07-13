import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { JSX, ReactNode } from "react";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { auth } from "@/lib/auth";
import { getCourseAccess } from "@/lib/course-access";
import { fetchServices, type PortalService } from "@/lib/services";

/**
 * The customer portal — the logged-in home for a services customer (Managed /
 * Setup week / Done-for-you). Mirrors the course app's account page: a
 * session-gated server component rendering a crimzon Section stack. Services +
 * live subscription state come from the Hono API (lib/services); course
 * all-access is read straight from the shared user DB (lib/course-access).
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your portal",
  robots: { index: false, follow: false },
};

const PLAN_COPY: Record<string, { name: string; detail: string }> = {
  managed: {
    name: "Managed instance",
    detail:
      "Your single-tenant Hogsend, run by us — upgrades and monitoring included.",
  },
  setup: {
    name: "Setup week",
    detail:
      "The one-week install — your program built and handed over in your repo.",
  },
  dfy: {
    name: "Done-for-you lifecycle",
    detail:
      "Install + operate — new journeys, experiments, and a weekly report.",
  },
};

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  trialing: "Active",
  paid: "Paid",
  past_due: "Past due",
  unpaid: "Past due",
  canceled: "Canceled",
  unknown: "—",
};

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
    new Date(iso),
  );
}

/** Course-account-style stacked section: hairline top border + display title. */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="border-white/[0.08] border-t pt-8">
      <h2 className="font-display text-white text-xl tracking-[-0.02em]">
        {title}
      </h2>
      {description ? (
        <p className="mt-1.5 text-sm text-white/50 leading-6">{description}</p>
      ) : null}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function ServiceCard({ service }: { service: PortalService }): JSX.Element {
  const copy = PLAN_COPY[service.plan] ?? {
    name: service.plan,
    detail: "",
  };
  const status = service.status ?? "unknown";
  const active = status === "active" || status === "trialing";
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
      <div className="flex items-center justify-between gap-4">
        <span className="font-medium text-base text-white">{copy.name}</span>
        <TagPill accent={active}>{STATUS_LABELS[status] ?? status}</TagPill>
      </div>
      {copy.detail ? (
        <p className="mt-2 text-sm text-white/60 leading-6">{copy.detail}</p>
      ) : null}
      <p className="mt-3 text-white/50 text-xs">
        Purchased {formatDate(service.purchasedAt)}
        {service.currentPeriodEnd
          ? ` · ${service.cancelAtPeriodEnd ? "Cancels" : "Renews"} ${formatDate(service.currentPeriodEnd)}`
          : ""}
      </p>
    </div>
  );
}

export default async function PortalPage(): Promise<JSX.Element> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in?next=/portal");
  const { user } = session;

  const [services, course] = await Promise.all([
    fetchServices({ email: user.email, userId: user.id }),
    getCourseAccess(user.id),
  ]);

  return (
    <main className="container-page pt-32 pb-24">
      <div className="mx-auto flex max-w-2xl flex-col gap-10">
        <header>
          <p className="eyebrow text-white/50">Your portal</p>
          <h1 className="mt-2 font-display text-3xl text-white tracking-[-0.02em]">
            {user.name || "Welcome"}
          </h1>
          <p className="mt-1 text-sm text-white/50">{user.email}</p>
        </header>

        <Section
          title="Your services"
          description="Engagements and subscriptions, with live billing state."
        >
          {services === null ? (
            <p className="text-sm text-white/60">
              Couldn&apos;t load your services just now — refresh in a moment.
            </p>
          ) : services.length === 0 ? (
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
              <p className="text-sm text-white/70 leading-6">
                No services yet. The{" "}
                <Link
                  href="/pricing"
                  className="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white"
                >
                  managed instance and setup week
                </Link>{" "}
                are self-serve, and the{" "}
                <Link
                  href="/service"
                  className="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white"
                >
                  done-for-you program
                </Link>{" "}
                starts with a call.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {services.map((s) => (
                <ServiceCard key={`${s.plan}-${s.purchasedAt}`} service={s} />
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Course all-access"
          description="Measure → Keep → Grow — included with the setup week and done-for-you."
        >
          {course.allAccess ? (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-accent/40 bg-white/[0.02] p-5">
              <div>
                <p className="font-medium text-sm text-white">
                  All-access unlocked
                </p>
                <p className="mt-1 text-sm text-white/60">
                  Every chapter and the workbook, on this account.
                </p>
              </div>
              <Button
                href="https://course.hogsend.com"
                variant="accent"
                external
                icon
              >
                Open the course
              </Button>
            </div>
          ) : course.ownedCount > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
              <p className="text-sm text-white/70">
                You own {course.ownedCount} course
                {course.ownedCount === 1 ? "" : "s"} on this account.
              </p>
              <Button
                href="https://course.hogsend.com"
                variant="outline"
                external
                icon
              >
                Open the course
              </Button>
            </div>
          ) : (
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
              <p className="text-sm text-white/70 leading-6">
                A services purchase unlocks the full course automatically —
                it&apos;s my thinking on lifecycle, alongside the work we do
                together. You can also{" "}
                <a
                  href="https://course.hogsend.com"
                  className="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white"
                >
                  read the free chapters
                </a>{" "}
                any time.
              </p>
            </div>
          )}
        </Section>

        <Section
          title="Book a call"
          description="Time with Doug — scoping, a working session, or where the funnel leaks."
        >
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
            <p className="text-sm text-white/70">
              Tell me what you&apos;re working on and I&apos;ll send times.
            </p>
            <Button href="/service#enquire" variant="outline" icon>
              Request a call
            </Button>
          </div>
        </Section>

        <Section
          title="Account"
          description="One login across hogsend.com, the course, and the demo."
        >
          <div className="flex flex-wrap items-center gap-4">
            <SignOutButton />
            <a
              href="https://course.hogsend.com/account"
              className="text-sm text-white/60 underline decoration-white/30 underline-offset-4 transition-colors hover:text-white"
            >
              Profile, security &amp; data →
            </a>
          </div>
        </Section>
      </div>
    </main>
  );
}
