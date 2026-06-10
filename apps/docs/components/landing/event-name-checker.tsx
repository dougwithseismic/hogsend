"use client";

import { Check } from "lucide-react";
import { type FormEvent, type JSX, useState } from "react";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { AnalyticsEvent, capture } from "@/lib/analytics";
import { cn } from "@/lib/cn";

/**
 * The closed verb list from the event-naming convention
 * (content/docs/guides/event-naming.mdx §4). The final underscore-segment of
 * every event name must be one of these.
 */
const VERBS = new Set([
  "viewed",
  "clicked",
  "copied",
  "submitted",
  "selected",
  "provided",
  "subscribed",
  "unsubscribed",
  "started",
  "completed",
  "failed",
  "cancelled",
  "created",
  "updated",
  "deleted",
  "opened",
  "sent",
  "entered",
  "left",
]);

/** Present-tense (and synonym) → closed-list past-tense, for the suggester. */
const PAST_MAP: Record<string, string> = {
  view: "viewed",
  click: "clicked",
  tap: "clicked",
  tapped: "clicked",
  press: "clicked",
  pressed: "clicked",
  copy: "copied",
  submit: "submitted",
  select: "selected",
  provide: "provided",
  subscribe: "subscribed",
  unsubscribe: "unsubscribed",
  start: "started",
  begin: "started",
  began: "started",
  complete: "completed",
  finish: "completed",
  finished: "completed",
  fail: "failed",
  cancel: "cancelled",
  canceled: "cancelled",
  create: "created",
  update: "updated",
  delete: "deleted",
  remove: "deleted",
  removed: "deleted",
  open: "opened",
  send: "sent",
  enter: "entered",
  leave: "left",
};

/**
 * Whole-tail semantic rewrites for phrasal names whose natural past tense
 * ("signed_up", "logged_in") ends on a particle, not a closed-list verb.
 * Each maps to the conventional domain event instead — context included.
 */
const TAIL_REWRITES: Record<string, { context: string; tail: string }> = {
  signup: { context: "user", tail: "created" },
  sign_up: { context: "user", tail: "created" },
  signed_up: { context: "user", tail: "created" },
  user_signed_up: { context: "user", tail: "created" },
  login: { context: "session", tail: "started" },
  log_in: { context: "session", tail: "started" },
  logged_in: { context: "session", tail: "started" },
  user_logged_in: { context: "session", tail: "started" },
};

const AUTH_WORDS = new Set([
  "sign",
  "signup",
  "signed",
  "login",
  "log",
  "logged",
  "register",
  "auth",
  "password",
]);

/** A trailing `_v2` / `_2` is a variant marker, not a verb — skip it. */
const VERSION_SUFFIX = /^v?\d+$/;

type CheckResult = {
  /** The trimmed name that was checked. */
  name: string;
  valid: boolean;
  /** First failed rule id, or "pass". */
  rule: string;
  message?: string;
  suggestion?: string;
};

type Rule = {
  id: string;
  message: string;
  broken: (name: string) => boolean;
};

function contextOf(name: string): string {
  return name.split(".")[0] ?? "";
}

function tailOf(name: string): string {
  return name.split(".").slice(1).join(".");
}

/** Final underscore-segment of the tail, skipping `_v2`-style variant tails. */
function finalVerb(tail: string): string {
  const words = tail.split("_").filter(Boolean);
  let index = words.length - 1;
  while (index >= 0 && VERSION_SUFFIX.test(words[index] ?? "")) {
    index -= 1;
  }
  return words[index] ?? "";
}

/**
 * Ordered rule checks — the first broken rule is the verdict. Later rules can
 * assume earlier ones passed (the verb check, for instance, sees a lowercase
 * single-dot name).
 */
const RULES: Rule[] = [
  {
    id: "template_syntax",
    message:
      "Template-literal syntax in the name. Interpolating a value mints one event definition per value, forever — variance belongs in a property, not the name.",
    broken: (name) => /[${}]/.test(name),
  },
  {
    id: "colon",
    message:
      "Colons are reserved for engine system events (bucket:entered). Domain events you author take a dot.",
    broken: (name) => name.includes(":"),
  },
  {
    id: "spaces",
    message:
      "Spaces. Event names are snake_case — words joined with underscores, nothing else.",
    broken: (name) => /\s/.test(name),
  },
  {
    id: "uppercase",
    message:
      "Uppercase letters. The convention is all-lowercase snake_case — no camelCase, no Title Case.",
    broken: (name) => /[A-Z]/.test(name),
  },
  {
    id: "hyphens",
    message: "Hyphens. snake_case joins words with underscores, not dashes.",
    broken: (name) => name.includes("-"),
  },
  {
    id: "invalid_characters",
    message:
      "Characters outside a–z, 0–9, underscores and a single dot. Keep names plain.",
    broken: (name) => /[^a-z0-9_.]/.test(name),
  },
  {
    id: "missing_context",
    message:
      "No context. The shape is context.object_action — one word before the dot saying where the event comes from (docs., email., billing.).",
    broken: (name) => !name.includes("."),
  },
  {
    id: "multiple_dots",
    message:
      "More than one dot. billing.invoice.payment.failed is a hierarchy looking for a problem — one dot of context, then snake_case.",
    broken: (name) => name.split(".").length > 2,
  },
  {
    id: "empty_context",
    message:
      "Nothing before the dot. Context is a non-empty single word: docs, email, trial, billing.",
    broken: (name) => contextOf(name) === "",
  },
  {
    id: "context_not_single_word",
    message:
      "Context is one word, no underscores. Multi-word context belongs after the dot or in a property.",
    broken: (name) => contextOf(name).includes("_"),
  },
  {
    id: "missing_action",
    message:
      "Nothing after the dot. The shape is context.object_action — a noun, then a past-tense verb.",
    broken: (name) => tailOf(name) === "",
  },
  {
    id: "malformed_underscores",
    message:
      "Stray underscores — doubled, leading or trailing. One underscore between words, none at the edges.",
    broken: (name) => /_{2,}|^_|_$|\._|_\./.test(name),
  },
  {
    id: "not_past_tense",
    message:
      "The final word isn't a past-tense verb from the closed list (viewed, clicked, started, completed, …). An event records something that happened — state the fact.",
    broken: (name) => !VERBS.has(finalVerb(tailOf(name))),
  },
];

function guessContext(tail: string): string {
  const words = tail.split("_").filter(Boolean);
  return words.some((word) => AUTH_WORDS.has(word)) ? "auth" : "docs";
}

/** Map the tail's final verb to the closed list where a mapping exists. */
function fixVerb(tail: string): string {
  const words = tail.split("_").filter(Boolean);
  let index = words.length - 1;
  while (index >= 0 && VERSION_SUFFIX.test(words[index] ?? "")) {
    index -= 1;
  }
  const last = words[index];
  if (last && !VERBS.has(last) && PAST_MAP[last]) {
    words[index] = PAST_MAP[last] as string;
  }
  return words.join("_");
}

/**
 * Best-effort transform towards a conventional name. Lowercase, snake_case,
 * one dot, past tense — deliberately simple; where the heuristics run out the
 * rule explanation does the rest.
 */
function suggestFix(raw: string): string {
  let s = raw.trim();
  s = s.replace(/\$\{[^}]*\}/g, " ");
  s = s.replace(/[{}]/g, " ");
  s = s.replace(/:/g, ".");
  // camelCase / PascalCase boundaries → underscores, then flatten.
  s = s.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  s = s.toLowerCase();
  s = s.replace(/[\s-]+/g, "_");
  s = s.replace(/[^a-z0-9_.]/g, "");

  const segments = s
    .split(".")
    .map((segment) => segment.replace(/_+/g, "_").replace(/^_+|_+$/g, ""))
    .filter(Boolean);
  if (segments.length === 0) return "";

  let context: string;
  let tail: string;
  if (segments.length === 1) {
    // A lone context with nothing after its dot ("docs.") has no object or
    // action to work with — no suggestion beats a circular one.
    const afterFirstDot = s.split(".").slice(1).join("");
    if (s.indexOf(".") > 0 && afterFirstDot.replace(/_/g, "") === "") {
      return "";
    }
    tail = segments[0] as string;
    context = guessContext(tail);
  } else {
    context = (segments[0] as string).replace(/_/g, "");
    tail = segments.slice(1).join("_");
  }

  const rewrite = TAIL_REWRITES[tail];
  if (rewrite) return `${rewrite.context}.${rewrite.tail}`;

  tail = fixVerb(tail);
  if (!context || !tail) return "";
  return `${context}.${tail}`;
}

/** Run the ordered rules; first failure wins. */
function checkName(name: string): CheckResult {
  for (const rule of RULES) {
    if (rule.broken(name)) {
      // Self-consistency guard: a suggestion is only offered if it passes
      // every rule itself — the checker never proposes a name it would fail.
      const candidate = suggestFix(name);
      const suggestion =
        candidate &&
        candidate !== name &&
        RULES.every((r) => !r.broken(candidate))
          ? candidate
          : undefined;
      return {
        name,
        valid: false,
        rule: rule.id,
        message: rule.message,
        suggestion,
      };
    }
  }
  return { name, valid: true, rule: "pass" };
}

/* Field styling copied from email-capture.tsx so the two forms match. */
const INPUT_CLASS = cn(
  "h-12 w-full min-w-0 rounded-[10px] border border-white/[0.08]",
  "bg-white/[0.04] px-4 text-base text-white placeholder:text-white/40",
  "outline-none transition-colors duration-200 focus:border-white/20",
  "disabled:opacity-60",
);

const CHIP_CLASS = cn(
  "h-10 select-none rounded-[10px] border border-white/[0.08] bg-white/[0.02]",
  "px-4 font-mono text-sm text-white/80 transition-colors duration-200",
  "hover:border-white/20 hover:text-white",
);

/**
 * EventNameChecker — paste an event name, get a verdict against the
 * context.object_action convention. Checks run locally on submit (button or
 * Enter), never per keystroke; each check is captured as docs.name_checked —
 * the tool follows the convention it checks.
 */
export function EventNameChecker(): JSX.Element {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<CheckResult | null>(null);

  function runCheck(raw: string): void {
    const name = raw.trim();
    if (!name) return;
    const verdict = checkName(name);
    setResult(verdict);
    capture(AnalyticsEvent.NAME_CHECKED, {
      value: name.slice(0, 80),
      valid: verdict.valid,
      rule: verdict.rule,
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    runCheck(value);
  }

  function handleSuggestion(suggestion: string): void {
    setValue(suggestion);
    runCheck(suggestion);
  }

  return (
    <Section>
      <Reveal>
        <SectionHeading
          eyebrow="Try it"
          title="Paste a name, get a verdict"
          subtitle={
            <>
              The check runs locally, against the rules above. The result is
              captured as{" "}
              <code className="font-mono text-[13px] text-white/80">
                docs.name_checked
              </code>{" "}
              — the tool follows the convention it checks.
            </>
          }
        />
      </Reveal>

      <Reveal delay={0.1} className="mt-10 max-w-xl">
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-3 sm:flex-row"
        >
          <input
            type="text"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="docs.deploy_clicked"
            aria-label="Event name to check"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={120}
            className={cn(INPUT_CLASS, "font-mono text-sm sm:flex-1")}
          />
          <button
            type="submit"
            className={cn(
              "inline-flex h-12 select-none items-center justify-center",
              "rounded-[10px] bg-white px-5 font-medium text-[#0a0a0a]",
              "text-base tracking-[-0.02em] transition-colors duration-200",
              "hover:bg-white/90 sm:shrink-0",
            )}
          >
            Check
          </button>
        </form>

        <div role="status" aria-live="polite">
          {result?.valid ? (
            <div
              className={cn(
                "mt-4 flex items-center gap-2.5 rounded-[10px] border",
                "border-white/[0.08] bg-white/[0.02] px-4 py-3.5",
              )}
            >
              <Check
                aria-hidden="true"
                className="size-4 shrink-0 text-accent"
                strokeWidth={2}
              />
              <code className="break-all font-mono text-sm text-white">
                {result.name}
              </code>
              <span className="shrink-0 text-sm text-white/50">passes.</span>
            </div>
          ) : null}

          {result && !result.valid ? (
            <div
              className={cn(
                "mt-4 rounded-[10px] border border-white/[0.08]",
                "bg-white/[0.02] px-4 py-4",
              )}
            >
              <p className="text-sm text-white/70 leading-6">
                <code className="break-all font-mono text-white/90">
                  {result.name}
                </code>{" "}
                doesn&apos;t pass. {result.message}
              </p>
              {result.suggestion ? (
                <div className="mt-3 flex flex-wrap items-center gap-2.5">
                  <span className="text-white/40 text-xs">Try</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (result.suggestion) {
                        handleSuggestion(result.suggestion);
                      }
                    }}
                    className={CHIP_CLASS}
                  >
                    {result.suggestion}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Reveal>
    </Section>
  );
}
