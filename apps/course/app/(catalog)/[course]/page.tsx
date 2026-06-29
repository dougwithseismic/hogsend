import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ds/button";
import { COURSES, getCourse } from "@/lib/courses";
import { source } from "@/lib/source";

export function generateStaticParams() {
  return COURSES.map((c) => ({ course: c.slug }));
}

export async function generateMetadata(props: {
  params: Promise<{ course: string }>;
}): Promise<Metadata> {
  const { course: slug } = await props.params;
  const course = getCourse(slug);
  if (!course) return {};
  return { title: course.title, description: course.tagline };
}

export default async function CourseOverview(props: {
  params: Promise<{ course: string }>;
}) {
  const { course: slug } = await props.params;
  const course = getCourse(slug);
  if (!course) notFound();

  const lessons = source
    .getPages()
    .filter((p) => p.slugs[0] === slug)
    .sort((a, b) => a.slugs.join("/").localeCompare(b.slugs.join("/")));

  const first = lessons[0];

  return (
    <article className="container-page py-16 md:py-24">
      <Link
        href="/"
        className="text-sm text-white/40 transition-colors hover:text-white"
      >
        ← All courses
      </Link>

      <p className="kicker mt-8 mb-3">
        {course.level} · {course.estimate}
      </p>
      <h1 className="max-w-3xl font-display text-[36px] leading-[1.1] tracking-[-0.03em] md:text-[48px]">
        {course.title}
      </h1>
      <p className="mt-5 max-w-2xl text-lg text-white/60 leading-7">
        {course.summary}
      </p>

      {first ? (
        <div className="mt-8">
          <Button href={first.url} variant="accent" icon>
            Start the course
          </Button>
        </div>
      ) : null}

      <ol className="mt-14 flex flex-col">
        {lessons.map((lesson, i) => (
          <li key={lesson.url}>
            <Link
              href={lesson.url}
              className="group flex items-baseline gap-4 border-hairline-faint border-t py-5 transition-colors hover:bg-white/[0.02]"
            >
              <span className="w-8 shrink-0 font-mono text-sm text-white/30">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="flex-1">
                <span className="block font-medium text-white transition-colors group-hover:text-accent">
                  {lesson.data.title}
                </span>
                {lesson.data.description ? (
                  <span className="mt-1 block text-sm text-white/50 leading-6">
                    {lesson.data.description}
                  </span>
                ) : null}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </article>
  );
}
