import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

type Lesson = {
  /** Short practice label, e.g. "Version control". */
  label: string;
  title: string;
  body: string;
};

const LESSONS: Lesson[] = [
  {
    label: "Version control",
    title: "Every change has a history",
    body: "Edit a template in a dashboard and the previous version is gone — nobody can say what the welcome email looked like in March. In a repo, every subject line has a diff, an author, and a way back.",
  },
  {
    label: "Code review",
    title: "A second pair of eyes before it sends",
    body: "Your welcome email gets read more often than your homepage, and in most tools it goes live because someone clicked Save. In a repo it ships the way the rest of the product does — through a pull request.",
  },
  {
    label: "Experiments",
    title: "Tests you can still read next quarter",
    body: "Most A/B tests end as a memory of which variant won — the losing copy deleted, the result in someone's head. When variants are code, an experiment is a branch: dated, diffed, and still answerable a year later.",
  },
  {
    label: "Automation",
    title: "Why click what you could type?",
    body: "A canvas flow is forty drag-and-drops nobody can review, reuse, or hand off. The same logic is a dozen lines of TypeScript — and typed code in a repo is exactly the surface coding agents are already good at.",
  },
  {
    label: "Time to ship",
    title: "An afternoon, not a quarter",
    body: "Standing lifecycle email up in a platform means weeks of building templates and clicking flows together before anything sends. The scaffold ships 10 journeys and 13 templates in one command — you edit, you don't assemble.",
  },
  {
    label: "Cost",
    title: "Growth shouldn't be a billing event",
    body: "Rented platforms meter contacts, so your list growing is their revenue. Software you run costs the same at 50,000 contacts as it did at 500 — Postgres doesn't charge per row.",
  },
];

/**
 * "What growth can learn from engineering" — the worldview section: six
 * editorial rows contrasting dashboard habits with engineering practice
 * (versioning, review, experiments, typing over clicking, setup time, rent).
 * Stacked hairline rows rather than a card grid, so it reads as an argument,
 * not a feature list.
 */
export function GrowthLessons() {
  return (
    <Section id="growth-lessons">
      <Reveal>
        <SectionHeading
          eyebrow="Growth, meet engineering"
          title="What growth can learn from engineering"
          subtitle="Lifecycle email has been run from dashboards for fifteen years, and dashboards never picked up the habits that make software dependable. Run it like the rest of your product and a few old problems stop being problems."
        />
      </Reveal>

      <div className="mt-12 md:mt-16">
        {LESSONS.map((lesson, index) => (
          <Reveal key={lesson.label} delay={Math.min(index, 2) * 0.06}>
            <div className="grid grid-cols-1 gap-4 border-white/[0.08] border-t py-8 md:grid-cols-[260px_1fr] md:gap-10 md:py-10">
              <div className="flex items-baseline gap-4">
                <span className="font-mono text-sm text-white/35">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="eyebrow text-white/50">{lesson.label}</span>
              </div>

              <div className="flex flex-col gap-3">
                <h3 className="font-display font-medium text-2xl text-white tracking-[-0.02em] md:text-[28px] md:leading-[34px]">
                  {lesson.title}
                </h3>
                <p className="max-w-2xl text-base text-white/60 leading-6">
                  {lesson.body}
                </p>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
