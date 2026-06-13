import type { RecipeLander } from "./types";

const TASK_CODE = `// The template's prop contract. This schema is the ENTIRE surface the
// model can fill — everything else in the email is the registry component.
const TipsDraft = z.object({
  subjectLine: z.string().max(80),
  tips: z
    .array(z.object({ title: z.string().max(60), body: z.string().max(280) }))
    .length(3),
});

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

export const draftWeeklyTipsTask = hatchet.durableTask({
  name: "draft-weekly-tips",
  onEvents: [Events.ONBOARDING_WEEK_COMPLETED],
  retries: 2,
  executionTimeout: "10m",
  fn: async (input: WeekCompletedInput) => {
    const { db } = getContainer();

    const userId = typeof input.userId === "string" ? input.userId : "";
    const email = typeof input.userEmail === "string" ? input.userEmail : "";
    if (!userId || !email) {
      return { status: "skipped", reason: "missing_identity" };
    }

    // The personalization source is your own event log, not the payload.
    const recent = await db.query.userEvents.findMany({
      where: and(
        eq(userEvents.userId, userId),
        gte(userEvents.occurredAt, new Date(Date.now() - 7 * 86_400_000)),
      ),
      orderBy: [desc(userEvents.occurredAt)],
      limit: 50,
    });
    const activity = recent.map((e) => e.event).join("\\n");

    const response = await anthropic.messages.parse({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system:
        "You write short, concrete product tips for a developer audience. " +
        "Plain prose. No exclamation marks, no emoji.",
      messages: [
        {
          role: "user",
          content: \`Events this user fired in their first week, newest first:\\n\${activity}\\n\\nDraft a subject line and three tips for what to do next.\`,
        },
      ],
      output_config: { format: zodOutputFormat(TipsDraft) },
    });

    // The gate. parsed_output is null when the completion failed
    // validation; TipsDraft.parse throws on null or any shape drift —
    // the task fails and Hatchet retries it. Nothing has been sent yet.
    const draft = TipsDraft.parse(response.parsed_output);

    await sendEmail({
      to: email,
      userId,
      template: Templates.LIFECYCLE_WEEKLY_TIPS, // "lifecycle/weekly-tips"
      subject: draft.subjectLine,
      props: { tips: draft.tips },
    });

    return { status: "sent" };
  },
});`;

const REGISTRY_CODE = `// src/emails/registry.ts (augmentation excerpt)
declare module "@hogsend/email" {
  interface TemplateRegistryMap {
    "lifecycle/weekly-tips": {
      tips: { title: string; body: string }[];
    };
  }
}

// sendEmail's props are typed against this augmentation, so if the zod
// schema drifts from the registry contract, the send line in the task
// stops compiling.`;

export const aiDraftedSends: RecipeLander = {
  slug: "ai-drafted-sends",
  category: "agentic",
  title: "AI-drafted sends",
  metaDescription:
    "A custom Hatchet task asks claude-haiku-4-5 for typed template props, validates the completion with zod before sendEmail, and renders through the code-owned registry template — a malformed completion is a failed task, not a malformed email.",
  cardDescription:
    "The model fills typed prop slots; the template, footer, and tracking stay code-owned.",
  eyebrow: "Recipe — Agents & AI",
  subhead:
    "A Hatchet task calls claude-haiku-4-5 for exactly the props the registry template accepts, gates the completion with zod, and only then sends — so a bad completion fails the task instead of reaching an inbox.",
  problem: {
    label: "The model-writes-email problem",
    statement:
      "Letting a model produce email HTML puts the unsubscribe footer, the List-Unsubscribe headers, and link tracking at the mercy of a completion. Without a validation gate, a malformed response becomes a malformed email in a customer's inbox, and drift between what the model returns and what the template expects surfaces at render time or not at all.",
  },
  walkthrough: {
    eyebrow: "The task",
    title: "Draft, validate, then send — in that order",
    subtitle:
      "One zod schema defines what the model may produce; the completion is constrained against it, parsed against it, and only a passing draft reaches sendEmail.",
    note: "The send is the last statement in the task. A failure at the model call or the validation gate fails the task before any email exists, so Hatchet's retries are always safe to run.",
  },
  code: [
    {
      filename: "src/workflows/draft-weekly-tips.ts",
      code: TASK_CODE,
      caption:
        "The model never sees the template. It fills a subject line and three typed tips; the registry component owns the markup, the footer, and the tracking.",
    },
    {
      filename: "src/emails/registry.ts",
      code: REGISTRY_CODE,
      caption:
        "One contract, two checks: the augmentation type-checks the send at compile time, the zod schema gates the completion at run time.",
    },
  ],
  points: [
    {
      title: "The schema is the model's entire surface",
      body: "zodOutputFormat constrains the completion to the template's prop contract, including length caps on subject and tip bodies — over-long copy fails validation instead of breaking the layout.",
    },
    {
      title: "A malformed completion is a failed task",
      body: "parsed_output is null when validation fails, and TipsDraft.parse throws on null or any shape drift. The task fails before sendEmail runs, Hatchet retries it (retries: 2), and no email leaves the pipeline.",
    },
    {
      title: "Compile-time agreement between schema and template",
      body: "sendEmail's props are typed against the TemplateRegistryMap augmentation, so if the zod schema and the registered props drift apart, the send line stops compiling.",
    },
    {
      title: "Still a tracked, preference-checked send",
      body: "sendEmail runs the engine's full pipeline — preference and suppression checks, link rewriting, the open pixel, the email_sends row. An unsubscribed user receives nothing regardless of what the model drafted.",
    },
  ],
  faq: [
    {
      q: "What happens when the model returns junk?",
      a: "The SDK validates the completion against the zod schema; on failure parsed_output is null and TipsDraft.parse throws. The task fails and Hatchet retries it. Because the send is the last step, a retry never duplicates an email that was never sent.",
    },
    {
      q: "Why not let the model write the whole email?",
      a: "Markup, the unsubscribe footer, List-Unsubscribe headers, and tracking rewrites are compliance and deliverability surface — they ride on the code-owned registry component the engine renders. The model fills typed slots inside that component, nothing more.",
    },
    {
      q: "Why claude-haiku-4-5?",
      a: "Filling a small typed schema from a short activity log is a constrained completion, and Haiku is the fast, lowest-cost tier. The gate is model-agnostic — swap the model string for a more capable one without touching the validation or the send.",
    },
    {
      q: "Why a task instead of calling the model inside a journey?",
      a: "A dedicated task gets its own retry budget and timeout, and onEvents routing means anything that can fire onboarding.week_completed — your app, a journey via ctx.trigger, an agent — can request a draft. Journeys stay orchestration; the draft step is a service.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/ai-drafted-sends",
    },
    {
      label: "Email guide — templates, registry, type safety",
      href: "/docs/guides/email",
    },
    {
      label: "Journeys guide — tasks vs journeys",
      href: "/docs/guides/journeys",
    },
  ],
  related: ["agent-triggered-journeys", "agent-feedback-loop", "weekly-digest"],
};
