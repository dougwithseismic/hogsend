import { Button } from "@/components/ds/button";
import { CodeMock } from "@/components/ds/mockup";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

// What `create-hogsend` actually emits — a running app with real journeys
// already wired in `src/journeys/`, not an empty editor.
const SCAFFOLD_LINES = [
  { text: "$ pnpm dlx create-hogsend@latest my-app", tone: "accent" },
  { text: "", tone: "plain" },
  { text: "my-app/src/journeys/", tone: "comment" },
  {
    text: "  welcome.ts          # signup → welcome → activation nudge",
    tone: "plain",
  },
  {
    text: "  trial-expiring.ts   # trial → reminders → win-back",
    tone: "plain",
  },
  {
    text: "  test-onboarding.ts  # a fast end-to-end smoke flow",
    tone: "plain",
  },
  { text: "", tone: "plain" },
  { text: "# edit these. delete what you don't need.", tone: "comment" },
  { text: "# you're shipping real flows on day one.", tone: "comment" },
] as const;

/**
 * "Start from a working app" — the anti-blank-page beat. `create-hogsend` emits
 * a running app with example journeys already wired, so the first thing you do
 * is edit a real flow, not stare at an empty file. Dark section; copy on the
 * left, the scaffolded tree on the right.
 */
export function Scaffolding() {
  return (
    <Section tone="dark" id="scaffolding">
      <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-16">
        <Reveal>
          <SectionHeading
            tone="dark"
            eyebrow="NOT A BLANK PAGE"
            title="Start from a working app"
            subtitle="Scaffold and you get a running app — example journeys already wired and ready to edit. Change the copy, tweak the timing, delete what you don't need. You're editing real lifecycle flows on day one, not staring at an empty editor."
          />

          <div className="mt-9 flex flex-wrap gap-4">
            <Button href="/docs/getting-started" variant="accent" icon>
              Get started
            </Button>
            <Button href="/recipes" variant="outline" tone="dark">
              Browse the cookbook
            </Button>
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <CodeMock filename="terminal" lines={[...SCAFFOLD_LINES]} />
        </Reveal>
      </div>
    </Section>
  );
}
