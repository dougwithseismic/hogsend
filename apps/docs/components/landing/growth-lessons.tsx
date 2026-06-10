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
    body: "Edit a template in a dashboard and the old version is gone. Nobody can say what the welcome email said in March, who changed it, or why. In a repo every subject line has a diff and a way back.",
  },
  {
    label: "Code review",
    title: "A second pair of eyes before it sends",
    body: "Your welcome email gets read more often than your homepage. In most tools it goes live the moment someone clicks Save. In a repo it goes out through the same pull request as everything else you ship.",
  },
  {
    label: "Experiments",
    title: "Tests you can still read next quarter",
    body: "Most A/B tests survive as a memory of which variant won. The losing copy gets deleted and the reasoning lives in someone's head. When variants are code, the whole experiment stays on the record.",
  },
  {
    label: "Automation",
    title: "Why click what you could type?",
    body: "A canvas flow is forty drag-and-drops that nobody can review, reuse, or hand to an agent. The same logic is a dozen lines of TypeScript, and agents are already very good at writing those.",
  },
  {
    label: "Time to ship",
    title: "Working by this afternoon",
    body: "Most platforms want weeks of template building and flow clicking before the first send. The scaffold puts 10 journeys and 13 templates in your repo with one command, so the work starts at editing.",
  },
  {
    label: "Cost",
    title: "Growth shouldn't be a billing event",
    body: "Rented platforms meter contacts, which makes your growth their revenue. Self-hosted software costs the same at 50,000 contacts as it did at 500. Postgres has never charged anyone per row.",
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
          eyebrow="Growth, meet engineering"
          title="What growth can learn from engineering"
          subtitle="Email tools never picked up the habits that make software dependable. Bring lifecycle email into the repo and it inherits all of them at once."
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
