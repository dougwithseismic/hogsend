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
    body: "Every template and journey has a git history. What the welcome email said in March is one git log away, with who changed it and why.",
  },
  {
    label: "Code review",
    title: "The same pull request as everything else",
    body: "A journey ships through the same pull request as the rest of your product. Nothing goes live because someone clicked Save.",
  },
  {
    label: "Experiments",
    title: "Finished tests stay on the record",
    body: "Variants are code, so finished A/B tests stay in history — the losing copy, the reasoning, the result.",
  },
  {
    label: "Automation",
    title: "A dozen lines instead of a canvas",
    body: "A canvas flow is forty drag-and-drops; the same logic is a dozen lines of TypeScript that fit in a diff.",
  },
  {
    label: "Time to ship",
    title: "The work starts at editing",
    body: "The scaffold puts 10 journeys and 13 templates in your repo with one command. The work starts at editing, not building.",
  },
  {
    label: "Cost",
    title: "Costs scale with infrastructure",
    body: "Self-hosted software costs the same at 50,000 contacts as at 500. Costs scale with your infrastructure, not your list.",
  },
];

/**
 * "What growth can learn from engineering" — six compact entries contrasting
 * dashboard habits with engineering practice (versioning, review,
 * experiments, typing over clicking, setup time, rent). Two-column hairline
 * list so it reads as an argument without dominating the page.
 */
export function GrowthLessons() {
  return (
    <Section id="growth-lessons">
      <Reveal>
        <SectionHeading
          eyebrow="Why a repo"
          title="What the repo gives you"
          subtitle="Lifecycle email in a repo inherits the habits that make software dependable."
        />
      </Reveal>

      <div className="mt-10 grid grid-cols-1 gap-x-14 md:mt-12 md:grid-cols-2">
        {LESSONS.map((lesson, index) => (
          <Reveal key={lesson.label} delay={(index % 2) * 0.06}>
            <div className="flex flex-col gap-2.5 border-white/[0.08] border-t py-7">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-white/35 text-xs">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="eyebrow text-white/50">{lesson.label}</span>
              </div>

              <h3 className="font-display font-medium text-white text-xl tracking-[-0.02em] md:text-[22px] md:leading-[28px]">
                {lesson.title}
              </h3>

              <p className="text-[15px] text-white/60 leading-6">
                {lesson.body}
              </p>
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
