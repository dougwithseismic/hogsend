import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { JSX, ReactNode } from "react";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { BookCall } from "@/components/portal/book-call";
import { ProfileForm } from "@/components/portal/profile-form";
import { SecuritySection } from "@/components/portal/security-section";
import { SignAgreement } from "@/components/portal/sign-agreement";
import { SubscriptionActions } from "@/components/portal/subscription-actions";
import { UpdateCard } from "@/components/portal/update-card";
import { fetchAgreements } from "@/lib/agreements";
import { auth } from "@/lib/auth";
import { fetchBilling } from "@/lib/billing";
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

const DATE_FMT = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

/** Lenient by design — upstream data is sanitized, but a bad date must never
 *  turn into an Intl RangeError that 500s the whole portal. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return DATE_FMT.format(date);
}

const AMOUNT_FMTS = new Map<string, Intl.NumberFormat>();

/** Stripe bills these currencies in whole units / thousandths, not cents. */
const ZERO_DECIMAL = new Set(
  "BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF UGX VND VUV XAF XOF XPF".split(" "),
);
const THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

/** Minor units + ISO currency → "$149.00". Lenient like formatDate. */
function formatAmount(minor: number, currency: string): string {
  const code = currency.toUpperCase();
  const units =
    minor / (ZERO_DECIMAL.has(code) ? 1 : THREE_DECIMAL.has(code) ? 1000 : 100);
  let fmt = AMOUNT_FMTS.get(code);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: code,
      });
    } catch {
      return `${units.toFixed(2)} ${code}`;
    }
    AMOUNT_FMTS.set(code, fmt);
  }
  return fmt.format(units);
}

/** The account-card surface, shared by every block on this page. */
const CARD = "rounded-xl border border-white/[0.08] bg-white/[0.02] p-5";

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
    <div className={CARD}>
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
      {service.subscriptionId &&
      (status === "active" ||
        status === "trialing" ||
        status === "past_due") ? (
        <SubscriptionActions
          // Remount when the server state flips so a completed cancel/resume
          // gets fresh controls instead of the stale in-flight ones.
          key={String(service.cancelAtPeriodEnd ?? false)}
          subscriptionId={service.subscriptionId}
          cancelAtPeriodEnd={service.cancelAtPeriodEnd ?? false}
        />
      ) : null}
    </div>
  );
}

export default async function PortalPage(): Promise<JSX.Element> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in?next=/portal");
  const { user } = session;

  const [services, course, billing, agreements] = await Promise.all([
    fetchServices({ email: user.email, userId: user.id }),
    getCourseAccess(user.id),
    fetchBilling({ email: user.email, userId: user.id }),
    fetchAgreements({ email: user.email, userId: user.id }),
  ]);
  // Billing only earns a section once there's something to bill — and stays
  // visible as a soft-retry line when the read fails for a known customer.
  const showBilling =
    billing === null
      ? services !== null && services.length > 0
      : billing.paymentMethod !== null || billing.invoices.length > 0;

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
            <div className={CARD}>
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
              {services.map((s, i) => (
                <ServiceCard
                  // Server-rendered once, never reordered client-side.
                  // biome-ignore lint/suspicious/noArrayIndexKey: static list
                  key={i}
                  service={s}
                />
              ))}
            </div>
          )}
        </Section>

        {showBilling ? (
          <Section
            title="Billing"
            description="Your card and invoices — receipts open on Stripe."
          >
            {billing === null ? (
              <p className="text-sm text-white/60">
                Couldn&apos;t load your billing just now — refresh in a moment.
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                <div
                  className={`flex flex-wrap items-center justify-between gap-4 ${CARD}`}
                >
                  <p className="text-sm text-white/70">
                    {billing.paymentMethod
                      ? `Card on file: ${billing.paymentMethod.brand.toUpperCase()} ···· ${billing.paymentMethod.last4}`
                      : "No card on file yet."}
                  </p>
                  <UpdateCard />
                </div>
                {billing.invoices.length > 0 ? (
                  <ul className="flex flex-col divide-y divide-white/[0.06] rounded-xl border border-white/[0.08] bg-white/[0.02]">
                    {billing.invoices.map((inv) => (
                      <li
                        key={inv.number}
                        className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
                      >
                        <span className="text-sm text-white/80">
                          {formatDate(inv.created)}
                          <span className="ml-2 text-white/40">
                            {inv.number}
                          </span>
                        </span>
                        <span className="flex items-center gap-4">
                          <span className="text-sm text-white">
                            {formatAmount(inv.amount, inv.currency)}
                          </span>
                          {inv.hostedUrl ? (
                            <a
                              href={inv.hostedUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-white/60 text-xs underline decoration-white/30 underline-offset-4 hover:text-white"
                            >
                              View
                            </a>
                          ) : null}
                          {inv.pdfUrl ? (
                            <a
                              href={inv.pdfUrl}
                              className="text-white/60 text-xs underline decoration-white/30 underline-offset-4 hover:text-white"
                            >
                              PDF
                            </a>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
          </Section>
        ) : null}

        {/* Hidden when there are no active agreements (or the read failed) —
            signatures aren't time-critical, and a quiet portal beats an
            error box for a section most customers never need. */}
        {agreements && agreements.length > 0 ? (
          <Section
            title="Agreements"
            description="Engagement terms — review and sign in the portal."
          >
            <div className="flex flex-col gap-3">
              {agreements.map((a) => (
                <div key={`${a.docId}-${a.version}`} className={CARD}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="font-medium text-base text-white">
                      {a.title}
                    </span>
                    {a.signed ? (
                      <TagPill accent>Signed</TagPill>
                    ) : (
                      <TagPill>Awaiting signature</TagPill>
                    )}
                  </div>
                  {a.summary ? (
                    <p className="mt-2 text-sm text-white/60 leading-6">
                      {a.summary}
                    </p>
                  ) : null}
                  <div className="mt-4 max-h-72 overflow-y-auto rounded-md border border-white/[0.06] bg-black/20 p-4">
                    {a.body.split(/\n\n+/).map((para, i) => (
                      <p
                        // Static document text, never reordered.
                        // biome-ignore lint/suspicious/noArrayIndexKey: static prose
                        key={i}
                        className="mb-3 text-sm text-white/70 leading-6 last:mb-0"
                      >
                        {para}
                      </p>
                    ))}
                  </div>
                  <p className="mt-2 text-white/40 text-xs">
                    Version {a.version}
                  </p>
                  {a.signed ? (
                    <p className="mt-3 text-sm text-white/60">
                      Signed by {a.signed.signedName} on{" "}
                      {formatDate(a.signed.signedAt)}.
                    </p>
                  ) : (
                    <SignAgreement
                      docId={a.docId}
                      docVersion={a.version}
                      contentHash={a.contentHash}
                    />
                  )}
                </div>
              ))}
            </div>
          </Section>
        ) : null}

        <Section
          title="Course all-access"
          description="Measure → Keep → Grow — included with the setup week and done-for-you."
        >
          {course === null ? (
            <p className="text-sm text-white/60">
              Couldn&apos;t check your course access just now — refresh in a
              moment.
            </p>
          ) : course.allAccess ? (
            <div
              className={`flex flex-wrap items-center justify-between gap-4 ${CARD} border-accent/40`}
            >
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
            <div
              className={`flex flex-wrap items-center justify-between gap-4 ${CARD}`}
            >
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
            <div className={CARD}>
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
          description="Time with Doug — scoping, a working session, or where the funnel leaks. I'll reply with times."
        >
          <div className={CARD}>
            <BookCall email={user.email} />
          </div>
        </Section>

        <Section
          title="Profile"
          description="One login across hogsend.com, the course, and the demo."
        >
          <ProfileForm initialName={user.name ?? ""} email={user.email} />
        </Section>

        <Section title="Security">
          <div className="flex flex-col gap-6">
            <SecuritySection />
            <div>
              <SignOutButton />
            </div>
          </div>
        </Section>
      </div>
    </main>
  );
}
