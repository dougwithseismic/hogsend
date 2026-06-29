import { Button } from "@/components/ds/button";

/** Wall shown to anonymous readers on a gated lesson. Renders the lesson's
 *  title/description as a teaser, never the body, and links to sign-in with a
 *  validated return path. */
export function LessonGate({
  title,
  description,
  lessonUrl,
}: {
  title: string;
  description?: string;
  lessonUrl: string;
}) {
  const href = `/sign-in?next=${encodeURIComponent(lessonUrl)}`;
  return (
    <div className="container-page py-16 md:py-24">
      <p className="kicker mb-3">Free with sign-up</p>
      <h1 className="max-w-2xl font-display text-[32px] leading-[1.1] tracking-[-0.03em] md:text-[40px]">
        {title}
      </h1>
      {description ? (
        <p className="mt-4 max-w-xl text-lg text-white/60 leading-7">
          {description}
        </p>
      ) : null}
      <div className="mt-8 max-w-xl rounded-md border border-white/[0.08] bg-white/[0.015] p-6">
        <p className="text-white/80">
          This lesson is free — you just need an account to read it.
        </p>
        <p className="mt-1 text-sm text-white/50">
          The first lesson of every course is open. Create a free account to
          continue the rest.
        </p>
        <div className="mt-5">
          <Button href={href} variant="accent" icon>
            Create a free account
          </Button>
        </div>
      </div>
    </div>
  );
}
