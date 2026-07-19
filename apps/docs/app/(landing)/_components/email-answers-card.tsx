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
 * Left is the email: a Preview tab (the rendered mini email, buttons live) and
 * two code tabs (the React Email template with `EmailAction`, and the journey
 * side reading the answer from `ctx.waitForEvent`). Right is the wire: a
 * terminal feed of what the engine does at send time (links rewritten
 * first-party, open pixel injected) and, once the visitor answers, the click →
 * event → branch. The feed is illustrative; every code line is the real API.
 *
 * The answer click IS dogfooded: when the docs Hogsend client is configured it
 * captures `demosite.email_answer` with the answer + visitor team.
 */

type AnswerKey = "great" | "help";

const ANSWERS: Record<
  AnswerKey,
  { label: string; redirect: string; branch: string }
> = {
  great: {
    label: "Going great",
    redirect: "302 → app.example.com",
    branch: "great",
  },
  help: {
    label: "Need a hand",
    redirect: "302 → cal.com/you/help",
    branch: "help",
  },
};

type CodeTab = "preview" | "email" | "journey";
const CODE_TABS: Array<{ key: CodeTab; label: string }> = [
  { key: "preview", label: "Preview" },
  { key: "email", label: "src/emails/trial-check-in.tsx" },
  { key: "journey", label: "src/journeys/trial.ts" },
];

interface FeedLine {
  key: string;
  label: string;
  detail: string;
  hot?: boolean;
}

/** What the engine did at send time — before any answer arrives. */
const SEND_LINES: FeedLine[] = [
  { key: "sent", label: "email.sent", detail: "trial-check-in" },
  { key: "rewrite", label: "links rewritten", detail: "/v1/t/c/9f2c…" },
  { key: "pixel", label: "open pixel", detail: "/v1/t/o/58d1…" },
  {
    key: "wait",
    label: "ctx.waitForEvent",
    detail: "trial.check_in · 3d",
  },
];

type EmailAnswersCardProps = {
  /** Pre-highlighted (Shiki, RSC) code nodes for the two code tabs. */
  code: Record<Exclude<CodeTab, "preview">, ReactNode>;
  raw: Record<Exclude<CodeTab, "preview">, string>;
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
  const [tab, setTab] = useState<CodeTab>("preview");
  const [answer, setAnswer] = useState<AnswerKey | null>(null);
  const [lines, setLines] = useState<FeedLine[]>(SEND_LINES);

  const recipient = `${team}@acme.dev`;

  function respond(key: AnswerKey) {
    if (answer) return; // first click per (send, event) wins — like the wire
    setAnswer(key);
    const a = ANSWERS[key];
    setLines((prev) => [
      ...prev,
      { key: "click", label: "GET /v1/t/c/9f2c…", detail: a.redirect },
      {
        key: "event",
        label: "trial.check_in",
        detail: `{ answer: "${key}" }`,
        hot: true,
      },
      {
        key: "resume",
        label: "journey resumed",
        detail: `branch: ${a.branch}`,
      },
    ]);
    capture?.("demosite.email_answer", { answer: key, team });
  }

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[1fr_380px]">
      {/* LEFT — the email: preview with live buttons, then the real code. */}
      <div className="overflow-hidden rounded-lg border border-[#1c1d22] bg-[#101014] shadow-xl">
        <div className="flex items-center gap-1 overflow-x-auto border-white/[0.08] border-b px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {CODE_TABS.map((t) => {
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
              <CopyButton value={raw[tab]} />
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
                <span className="text-white/65">
                  Quick check-in on your trial
                </span>
              </p>
            </div>

            {/* The rendered email — a white card, like an email client. */}
            <div className="rounded-md bg-white px-6 py-7 text-[#1a1a1a]">
              <p className="text-[15px] leading-[24px]">
                Hey — you&rsquo;re a week into the trial. One click tells us
                where you are, straight from this email:
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => respond("great")}
                  disabled={answer !== null}
                  className={cn(
                    "rounded-[6px] px-4 py-2 font-medium text-sm transition-opacity",
                    "bg-[#f64838] text-white",
                    answer === null
                      ? "hover:opacity-85"
                      : answer === "great"
                        ? "opacity-100"
                        : "opacity-35",
                  )}
                >
                  {ANSWERS.great.label}
                </button>
                <button
                  type="button"
                  onClick={() => respond("help")}
                  disabled={answer !== null}
                  className={cn(
                    "rounded-[6px] border border-[#1a1a1a]/25 px-4 py-2 font-medium text-sm transition-opacity",
                    answer === null
                      ? "hover:border-[#1a1a1a]/60"
                      : answer === "help"
                        ? "opacity-100"
                        : "opacity-35",
                  )}
                >
                  {ANSWERS.help.label}
                </button>
              </div>
              <p className="mt-5 text-[#1a1a1a]/50 text-xs leading-[18px]">
                Each button is an EmailAction — a link whose click emits{" "}
                <span className="font-mono">trial.check_in</span> with its
                answer. First click wins.
              </p>
            </div>
          </div>
        ) : (
          <div className="ps-code max-h-[380px] overflow-auto px-4 py-4 text-[12.5px]">
            {code[tab]}
          </div>
        )}
      </div>

      {/* RIGHT — the wire: send-time work, then the answer landing. */}
      <ProductCard>
        <ProductCardHeader
          title="trial-check-in"
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
            className={cn(PRODUCT_MONO_VALUE_CLASS, "flex items-center gap-2")}
          >
            <span className="text-white/55">ctx.waitForEvent</span>
            <span className="text-white/30">→</span>
            {answer ? (
              <span className="text-[#f8a08f]">
                {"{"} answer: &quot;{answer}&quot; {"}"}
              </span>
            ) : (
              <span className="text-white/35">
                waiting for {TEAM_LABELS[team].toLowerCase()}@acme.dev…
              </span>
            )}
          </div>
        </ProductCardFooter>
      </ProductCard>
    </div>
  );
}
