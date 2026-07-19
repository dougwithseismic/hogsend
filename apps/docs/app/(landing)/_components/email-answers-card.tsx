"use client";

import { useHogsend } from "@hogsend/react";
import { type ReactNode, useState } from "react";
import { CopyButton } from "@/components/ds/copy-button";
import { isHogsendConfigured } from "@/components/hogsend/config";
import { cn } from "@/lib/cn";
import {
  PRODUCT_MONO_VALUE_CLASS,
  ProductCard,
  ProductCardFooter,
  ProductCardHeader,
  ProductLabel,
  ProductTag,
} from "./product-card";
import { TEAM_LABELS, useVisitorTeam } from "./team-context";

/**
 * "Email that answers back" — the demo where the visitor clicks a button in a
 * rendered email and watches the journey hear a TYPED event.
 *
 * A scenario row on top flips between five real answer patterns (trial
 * check-in, NPS, win-back reason, call-slot pick, roadmap vote). Left is the
 * email: a Preview tab (the rendered mini email, buttons live) and two code
 * tabs (the React Email template with `EmailAction`, and the journey side
 * reading the answer from `ctx.waitForEvent`). Right is the wire: a terminal
 * feed of what the engine does at send time (links rewritten first-party,
 * open pixel injected) and, once the visitor answers, the click → event →
 * branch. The feed is illustrative; every code line is the real API.
 *
 * The answer click IS dogfooded: when the docs Hogsend client is configured
 * it captures `demosite.email_answer` with the answer + scenario + team.
 */

export type AnswerScenarioKey = "trial" | "nps" | "winback" | "slot" | "vote";

type ScenarioAnswer = {
  key: string;
  label: string;
  redirect: string;
  branch: string;
  /** The event-properties payload shown on the wire, e.g. `{ score: 9 }`. */
  prop: string;
};

type Scenario = {
  key: AnswerScenarioKey;
  chip: string;
  title: string;
  subject: string;
  emailFile: string;
  journeyFile: string;
  body: string;
  event: string;
  /** ctx.waitForEvent detail on the wire, e.g. `nps.answered · 7d`. */
  waitDetail: string;
  footnote: string;
  /** `scale` renders the 0–10 NPS strip; `buttons` renders labeled answers. */
  kind: "buttons" | "scale";
  answers: ScenarioAnswer[];
};

const NPS_ANSWERS: ScenarioAnswer[] = Array.from({ length: 11 }, (_, i) => ({
  key: String(i),
  label: String(i),
  redirect: "302 → example.com/thanks",
  branch: i >= 9 ? "promoter" : i <= 6 ? "detractor" : "passive",
  prop: `{ score: ${i} }`,
}));

const SCENARIOS: Scenario[] = [
  {
    key: "trial",
    chip: "Trial check-in",
    title: "trial-check-in",
    subject: "Quick check-in on your trial",
    emailFile: "src/emails/trial-check-in.tsx",
    journeyFile: "src/journeys/trial.ts",
    body: "Hey — you're a week into the trial. One click tells us where you are, straight from this email:",
    event: "trial.check_in",
    waitDetail: "trial.check_in · 3d",
    footnote:
      "Each button is an EmailAction — a link whose click emits trial.check_in with its answer. First click wins.",
    kind: "buttons",
    answers: [
      {
        key: "great",
        label: "Going great",
        redirect: "302 → app.example.com",
        branch: "great",
        prop: '{ answer: "great" }',
      },
      {
        key: "help",
        label: "Need a hand",
        redirect: "302 → cal.com/you/help",
        branch: "help",
        prop: '{ answer: "help" }',
      },
    ],
  },
  {
    key: "nps",
    chip: "NPS survey",
    title: "nps-survey",
    subject: "One number — how are we doing?",
    emailFile: "src/emails/nps-survey.tsx",
    journeyFile: "src/journeys/nps.ts",
    body: "You're three months in. How likely are you to recommend us to a friend? Zero to ten, straight from this email:",
    event: "nps.answered",
    waitDetail: "nps.answered · 7d",
    footnote:
      "Each number is an EmailAction — a link whose click emits nps.answered with its score. First click wins.",
    kind: "scale",
    answers: NPS_ANSWERS,
  },
  {
    key: "winback",
    chip: "Win-back",
    title: "winback-reason",
    subject: "What pulled you away?",
    emailFile: "src/emails/winback-reason.tsx",
    journeyFile: "src/journeys/winback.ts",
    body: "Your account went quiet last month. No pitch — just tell us what pulled you away:",
    event: "winback.reason",
    waitDetail: "winback.reason · 7d",
    footnote:
      "Each button is an EmailAction — a link whose click emits winback.reason with its reason. First click wins.",
    kind: "buttons",
    answers: [
      {
        key: "pricing",
        label: "Too pricey",
        redirect: "302 → example.com/pricing",
        branch: "pricing",
        prop: '{ reason: "pricing" }',
      },
      {
        key: "missing_feature",
        label: "Missing a feature",
        redirect: "302 → example.com/roadmap",
        branch: "missing_feature",
        prop: '{ reason: "missing_feature" }',
      },
      {
        key: "busy",
        label: "Just busy",
        redirect: "302 → app.example.com",
        branch: "busy",
        prop: '{ reason: "busy" }',
      },
    ],
  },
  {
    key: "slot",
    chip: "Book a call",
    title: "onboarding-call",
    subject: "Pick a time for your onboarding call",
    emailFile: "src/emails/onboarding-call.tsx",
    journeyFile: "src/journeys/onboarding.ts",
    body: "Twenty minutes and we'll set up your first journey together. Pick whichever suits:",
    event: "onboarding.slot_picked",
    waitDetail: "onboarding.slot_picked · 3d",
    footnote:
      "Each button is an EmailAction — a link whose click emits onboarding.slot_picked with its slot. First click wins.",
    kind: "buttons",
    answers: [
      {
        key: "tue-10",
        label: "Tuesday 10:00",
        redirect: "302 → cal.com/you/onboarding",
        branch: "tue-10",
        prop: '{ slot: "tue-10" }',
      },
      {
        key: "thu-14",
        label: "Thursday 14:00",
        redirect: "302 → cal.com/you/onboarding",
        branch: "thu-14",
        prop: '{ slot: "thu-14" }',
      },
    ],
  },
  {
    key: "vote",
    chip: "Roadmap vote",
    title: "roadmap-vote",
    subject: "Which should we build next?",
    emailFile: "src/emails/roadmap-vote.tsx",
    journeyFile: "src/journeys/roadmap.ts",
    body: "Three candidates for next quarter. Your click is the ballot — one vote per send:",
    event: "roadmap.vote",
    waitDetail: "roadmap.vote · 14d",
    footnote:
      "Each button is an EmailAction — a link whose click emits roadmap.vote with its pick. First click wins.",
    kind: "buttons",
    answers: [
      {
        key: "webhooks",
        label: "Webhooks API",
        redirect: "302 → example.com/roadmap",
        branch: "webhooks",
        prop: '{ pick: "webhooks" }',
      },
      {
        key: "sso",
        label: "SSO",
        redirect: "302 → example.com/roadmap",
        branch: "sso",
        prop: '{ pick: "sso" }',
      },
      {
        key: "mobile",
        label: "Mobile app",
        redirect: "302 → example.com/roadmap",
        branch: "mobile",
        prop: '{ pick: "mobile" }',
      },
    ],
  },
];

type CodeTab = "preview" | "email" | "journey";

interface FeedLine {
  key: string;
  label: string;
  detail: string;
  hot?: boolean;
}

/** The wire feed: send-time work, plus the answer landing once clicked. */
function buildLines(scenario: Scenario, answer: ScenarioAnswer | undefined) {
  const lines: FeedLine[] = [
    { key: "sent", label: "email.sent", detail: scenario.title },
    { key: "rewrite", label: "links rewritten", detail: "/v1/t/c/9f2c…" },
    { key: "pixel", label: "open pixel", detail: "/v1/t/o/58d1…" },
    { key: "wait", label: "ctx.waitForEvent", detail: scenario.waitDetail },
  ];
  if (answer) {
    lines.push(
      { key: "click", label: "GET /v1/t/c/9f2c…", detail: answer.redirect },
      { key: "event", label: scenario.event, detail: answer.prop, hot: true },
      {
        key: "resume",
        label: "journey resumed",
        detail: `branch: ${answer.branch}`,
      },
    );
  }
  return lines;
}

type ScenarioCode = { email: ReactNode; journey: ReactNode };
type ScenarioRaw = { email: string; journey: string };

type EmailAnswersCardProps = {
  /** Pre-highlighted (Shiki, RSC) code nodes per scenario. */
  code: Record<AnswerScenarioKey, ScenarioCode>;
  raw: Record<AnswerScenarioKey, ScenarioRaw>;
};

export function EmailAnswersCard(props: EmailAnswersCardProps) {
  // Same idiom as the video players: only touch the Hogsend context when the
  // docs client is actually configured.
  return isHogsendConfigured ? (
    <CapturingEmailAnswersCard {...props} />
  ) : (
    <EmailAnswersCardInner {...props} capture={undefined} />
  );
}

function CapturingEmailAnswersCard(props: EmailAnswersCardProps) {
  const { capture } = useHogsend();
  return <EmailAnswersCardInner {...props} capture={capture} />;
}

function EmailAnswersCardInner({
  code,
  raw,
  capture,
}: EmailAnswersCardProps & {
  capture:
    | ((event: string, props?: Record<string, unknown>) => void)
    | undefined;
}) {
  const { team } = useVisitorTeam();
  const [scenarioKey, setScenarioKey] = useState<AnswerScenarioKey>("trial");
  const [tab, setTab] = useState<CodeTab>("preview");
  // One answer per scenario — first click per (send, event) wins, like the
  // wire; flipping scenarios keeps each send's answered state.
  const [answers, setAnswers] = useState<
    Partial<Record<AnswerScenarioKey, string>>
  >({});

  const scenario = SCENARIOS.find((s) => s.key === scenarioKey) ?? SCENARIOS[0];
  const answerKey = answers[scenario.key];
  const answer = scenario.answers.find((a) => a.key === answerKey);
  const lines = buildLines(scenario, answer);
  const recipient = `${team}@acme.dev`;

  const codeTabs: Array<{ key: CodeTab; label: string }> = [
    { key: "preview", label: "Preview" },
    { key: "email", label: scenario.emailFile },
    { key: "journey", label: scenario.journeyFile },
  ];

  function respond(key: string) {
    if (answerKey) return; // first click per (send, event) wins — like the wire
    setAnswers((prev) => ({ ...prev, [scenario.key]: key }));
    capture?.("demosite.email_answer", {
      answer: key,
      scenario: scenario.key,
      team,
    });
  }

  return (
    <div>
      {/* Scenario row — the same wire, five different questions. */}
      <div
        role="tablist"
        aria-label="Answer scenarios"
        className="mb-3 flex flex-wrap items-center gap-1.5"
      >
        {SCENARIOS.map((s) => {
          const isActive = s.key === scenario.key;
          return (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setScenarioKey(s.key)}
              className={cn(
                "select-none rounded-full border px-3 py-1.5 font-medium text-[12.5px] tracking-[-0.02em] outline-none transition-colors",
                isActive
                  ? "border-[#f64838]/35 bg-[#f64838]/[0.08] text-white"
                  : "border-white/10 text-white/55 hover:border-white/25 hover:text-white",
              )}
            >
              {s.chip}
              {answers[s.key] && (
                <span
                  aria-hidden="true"
                  className="ml-1.5 inline-block size-1.5 rounded-full bg-[#23c489] align-middle"
                />
              )}
            </button>
          );
        })}
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[1fr_380px]">
        {/* LEFT — the email: preview with live buttons, then the real code. */}
        <div className="overflow-hidden rounded-lg border border-[#1c1d22] bg-[#101014] shadow-xl">
          <div className="flex items-center gap-1 overflow-x-auto border-white/[0.08] border-b px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {codeTabs.map((t) => {
              const isActive = t.key === tab;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    "shrink-0 whitespace-nowrap border-b-2 px-2.5 py-2.5 font-mono text-[11px] tracking-wide outline-none transition-colors",
                    isActive
                      ? "border-[#f64838] text-white/80"
                      : "border-transparent text-white/40 hover:text-white/70",
                  )}
                >
                  {t.label}
                </button>
              );
            })}
            {tab !== "preview" && (
              <span className="ml-auto shrink-0 border-white/[0.06] border-l pl-2">
                <CopyButton value={raw[scenario.key][tab]} />
              </span>
            )}
          </div>

          {tab === "preview" ? (
            <div className="p-4 sm:p-6">
              {/* Envelope header — the persona shows up as the recipient. */}
              <div className="mb-4 space-y-1 font-mono text-[11px] text-white/40 tracking-wide">
                <p>
                  to: <span className="text-white/65">{recipient}</span>
                </p>
                <p>
                  subject:{" "}
                  <span className="text-white/65">{scenario.subject}</span>
                </p>
              </div>

              {/* The rendered email — a white card, like an email client. */}
              <div className="rounded-md bg-white px-6 py-7 text-[#1a1a1a]">
                <p className="text-[15px] leading-[24px]">{scenario.body}</p>

                {scenario.kind === "scale" ? (
                  <div className="mt-5">
                    <div className="flex flex-wrap gap-1.5">
                      {scenario.answers.map((a) => (
                        <button
                          key={a.key}
                          type="button"
                          onClick={() => respond(a.key)}
                          disabled={answerKey !== undefined}
                          className={cn(
                            "flex size-8 items-center justify-center rounded-[6px] font-medium text-sm transition-opacity",
                            answerKey === a.key
                              ? "bg-[#f64838] text-white"
                              : "border border-[#1a1a1a]/25",
                            answerKey === undefined
                              ? "hover:border-[#1a1a1a]/60"
                              : answerKey === a.key
                                ? "opacity-100"
                                : "opacity-35",
                          )}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                    <div className="mt-2 flex justify-between text-[#1a1a1a]/45 text-xs">
                      <span>Not likely</span>
                      <span>Very likely</span>
                    </div>
                  </div>
                ) : (
                  <div className="mt-5 flex flex-wrap gap-3">
                    {scenario.answers.map((a, i) => (
                      <button
                        key={a.key}
                        type="button"
                        onClick={() => respond(a.key)}
                        disabled={answerKey !== undefined}
                        className={cn(
                          "rounded-[6px] px-4 py-2 font-medium text-sm transition-opacity",
                          i === 0
                            ? "bg-[#f64838] text-white"
                            : "border border-[#1a1a1a]/25",
                          answerKey === undefined
                            ? i === 0
                              ? "hover:opacity-85"
                              : "hover:border-[#1a1a1a]/60"
                            : answerKey === a.key
                              ? "opacity-100"
                              : "opacity-35",
                        )}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}

                <p className="mt-5 text-[#1a1a1a]/50 text-xs leading-[18px]">
                  {scenario.footnote}
                </p>
              </div>
            </div>
          ) : (
            <div className="ps-code max-h-[380px] overflow-auto px-4 py-4 text-[12.5px]">
              {code[scenario.key][tab]}
            </div>
          )}
        </div>

        {/* RIGHT — the wire: send-time work, then the answer landing. */}
        <ProductCard>
          <ProductCardHeader
            title={scenario.title}
            tag={
              answer ? (
                <ProductTag tone="crimzon" pulse>
                  answered
                </ProductTag>
              ) : (
                <ProductTag>waiting</ProductTag>
              )
            }
            description="Sent through the tracked mailer: every link rewritten to your domain, opens and clicks first-party."
          />

          <div aria-live="polite" className="px-4 py-3">
            <ul className="space-y-2 font-mono text-[11.5px] tracking-wide">
              {lines.map((l) => (
                <li
                  key={l.key}
                  className="flex items-baseline justify-between gap-3"
                >
                  <span className={l.hot ? "text-[#f8a08f]" : "text-white/60"}>
                    {l.label}
                  </span>
                  <span
                    className={cn(
                      "truncate text-right",
                      l.hot ? "text-[#f8a08f]" : "text-white/35",
                    )}
                  >
                    {l.detail}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <ProductCardFooter>
            <ProductLabel className="mb-1.5">the journey hears</ProductLabel>
            <div
              className={cn(
                PRODUCT_MONO_VALUE_CLASS,
                "flex items-center gap-2",
              )}
            >
              <span className="text-white/55">ctx.waitForEvent</span>
              <span className="text-white/30">→</span>
              {answer ? (
                <span className="text-[#f8a08f]">{answer.prop}</span>
              ) : (
                <span className="text-white/35">
                  waiting for {TEAM_LABELS[team].toLowerCase()}@acme.dev…
                </span>
              )}
            </div>
          </ProductCardFooter>
        </ProductCard>
      </div>
    </div>
  );
}
