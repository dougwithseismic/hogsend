import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { BillingSection } from "@/components/account/billing-section";
import { DangerZone } from "@/components/account/danger-zone";
import { ProfileForm } from "@/components/account/profile-form";
import { SecuritySection } from "@/components/account/security-section";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { auth } from "@/lib/auth";
import { getCourse } from "@/lib/courses";
import { db } from "@/lib/db";
import { enrollment, lessonProgress } from "@/lib/db/schema";
import { source } from "@/lib/source";

// Reads the session + the user's DB rows — always per-request.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your account",
  robots: { index: false, follow: false },
};

/** Total lessons in a course (2+ segment pages under the course slug). */
function lessonCount(courseSlug: string): number {
  return source
    .getPages()
    .filter((p) => p.slugs.length >= 2 && p.slugs[0] === courseSlug).length;
}

/** Consistent settings-section wrapper: a labelled heading + a hairline divider. */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-white/[0.08] border-t pt-8">
      <h2 className="font-display text-xl tracking-[-0.02em]">{title}</h2>
      {description ? (
        <p className="mt-1 text-sm text-white/50 leading-6">{description}</p>
      ) : null}
      <div className="mt-5">{children}</div>
    </section>
  );
}

export default async function AccountPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in?next=/account");
  const user = session.user;

  const [enrolls, progress] = await Promise.all([
    db.select().from(enrollment).where(eq(enrollment.userId, user.id)),
    db.select().from(lessonProgress).where(eq(lessonProgress.userId, user.id)),
  ]);

  const completedByCourse = new Map<string, number>();
  for (const p of progress) {
    completedByCourse.set(
      p.courseSlug,
      (completedByCourse.get(p.courseSlug) ?? 0) + 1,
    );
  }

  return (
    <main className="container-page py-16 md:py-24">
      <div className="mx-auto flex max-w-2xl flex-col gap-10">
        <header>
          <p className="kicker">Your account</p>
          <h1 className="mt-2 font-display text-3xl tracking-[-0.02em]">
            {user.name || "Profile"}
          </h1>
          <p className="mt-1 text-white/50">{user.email}</p>
        </header>

        <Section title="Profile">
          <ProfileForm initialName={user.name ?? ""} email={user.email} />
        </Section>

        <Section title="Your courses">
          {enrolls.length === 0 ? (
            <p className="text-sm text-white/50 leading-6">
              You haven't started a course yet.{" "}
              <Link href="/" className="text-accent hover:underline">
                Browse courses →
              </Link>
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {enrolls.map((e) => {
                const total = lessonCount(e.courseSlug);
                const done = completedByCourse.get(e.courseSlug) ?? 0;
                const pct = total ? Math.round((done / total) * 100) : 0;
                const course = getCourse(e.courseSlug);
                return (
                  <li
                    key={e.courseSlug}
                    className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <span className="font-display tracking-[-0.02em]">
                        {course?.title ?? e.courseSlug}
                      </span>
                      <span className="shrink-0 text-sm text-white/50">
                        {done}/{total} · {pct}%{e.completedAt ? " · done" : ""}
                      </span>
                    </div>
                    <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                      <div
                        className="h-full rounded-full bg-accent transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <Link
                      href={`/${e.courseSlug}`}
                      className="mt-3 inline-block text-sm text-white/60 transition-colors hover:text-white"
                    >
                      Continue →
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title="Billing & invoices">
          <BillingSection userId={user.id} />
        </Section>

        <Section title="Security">
          <div className="flex flex-col gap-6">
            <SecuritySection />
            <div>
              <SignOutButton />
            </div>
          </div>
        </Section>

        <Section
          title="Privacy & data"
          description="Export everything we hold, or permanently delete your account."
        >
          <DangerZone />
        </Section>
      </div>
    </main>
  );
}
