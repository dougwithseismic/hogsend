import Link from "next/link";
import { PillBadge } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import { COURSES } from "@/lib/courses";
import { source } from "@/lib/source";

export default function CatalogPage() {
  const pages = source.getPages();

  return (
    <>
      <section className="container-page py-20 md:py-28">
        <p className="kicker mb-4">Free courses</p>
        <h1 className="max-w-3xl font-display text-[40px] leading-[1.1] tracking-[-0.03em] md:text-[56px]">
          Build your growth in code.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-white/60 leading-7">
          Start-to-finish courses on PostHog, lifecycle messaging, and turning
          traffic into an audience you own — written for the people who build
          it. Free to read.
        </p>
      </section>

      <section className="container-page border-hairline-faint border-t py-16">
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {COURSES.map((course) => {
            const lessonCount = pages.filter(
              (p) => p.slugs[0] === course.slug,
            ).length;
            return (
              <Link
                key={course.slug}
                href={`/${course.slug}`}
                className="group block"
              >
                <Card className="flex h-full flex-col gap-4 group-hover:border-white/15">
                  <div className="flex items-center gap-2">
                    <PillBadge>{course.level}</PillBadge>
                  </div>
                  <h2 className="font-display text-2xl leading-tight tracking-[-0.02em]">
                    {course.title}
                  </h2>
                  <p className="text-base text-white/60 leading-6">
                    {course.tagline}
                  </p>
                  <div className="mt-auto flex items-center gap-3 pt-4 text-sm text-white/40">
                    <span>{lessonCount} lessons</span>
                    <span aria-hidden>·</span>
                    <span>{course.estimate}</span>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      </section>
    </>
  );
}
