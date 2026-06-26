import { createElement, type ReactElement, type ReactNode } from "react";
import { EmailAction, HOSTED_ANSWER_HREF } from "./email-action.js";

/**
 * Engine-reserved event namespaces. The link rewriter is the authority and
 * rejects these at SEND time; here we only emit a dev-time warning so the
 * mistake surfaces while authoring (never throw — the engine decides).
 */
const RESERVED_PREFIXES = [
  "email.",
  "journey.",
  "bucket.",
  "contact.",
] as const;

/** A single answer option — the value is written into the emitted event. */
type SurveyOptionValue = string | number | boolean;

interface SurveyOption {
  label: string;
  value: SurveyOptionValue;
}

export interface SurveyProps {
  /** Shared consumer event name emitted by EVERY anchor when clicked. */
  event: string;
  /** Survey shape. `nps` forces a 0..10 scale. */
  mode: "scale" | "nps" | "yesno" | "choice";
  /** Scalar key the chosen value is written under. Default `"value"`. */
  property?: string;
  /** scale lower/upper bound (default 1..5). Ignored for nps (forced 0..10). */
  min?: number;
  max?: number;
  /** Optional end labels rendered alongside a scale/nps row. */
  minLabel?: string;
  maxLabel?: string;
  /**
   * choice/yesno options. `yesno` defaults to Yes=`true` / No=`false`; `choice`
   * requires explicit options.
   */
  choices?: SurveyOption[];
  /** Forwarded to each EmailAction (react-email's Tailwind still applies). */
  className?: string;
  /** Each anchor's `href` falls back to the hosted answer page. Default true. */
  hostedAnswer?: boolean;
  /** Per-option landing-page override (wins over the hosted-answer fallback). */
  hrefFor?: (value: string | number) => string;
}

/** Build the ordered option list for a survey mode. */
function buildOptions(props: SurveyProps): SurveyOption[] {
  if (props.mode === "yesno") {
    return (
      props.choices ?? [
        { label: "Yes", value: true },
        { label: "No", value: false },
      ]
    );
  }
  if (props.mode === "choice") {
    return props.choices ?? [];
  }
  // scale / nps — a numeric run from min..max.
  const isNps = props.mode === "nps";
  const min = isNps ? 0 : (props.min ?? 1);
  const max = isNps ? 10 : (props.max ?? 5);
  const out: SurveyOption[] = [];
  for (let v = min; v <= max; v += 1) out.push({ label: String(v), value: v });
  return out;
}

/**
 * `<Survey>` — pure presentation over {@link EmailAction}, with NO pipeline
 * change: it composes N semantic-link anchors that share one `event` and write
 * the chosen value under `property` (default `"value"`). A scale renders one
 * anchor per step, an NPS eleven (0..10), a yes/no two, a choice one per option.
 *
 * The engine lifts the anchors' `data-hs-*` metadata at send time (the existing
 * semantic-link wire), so a journey reads the answer via
 * `ctx.waitForEvent → properties` and the reporting aggregate groups on it —
 * identically to a hand-written set of `EmailAction`s.
 *
 * Plain `.ts` + `createElement` (no JSX) so consumers type-checking this
 * package's raw source need no `jsx` compiler setting (mirrors `email-action`).
 */
export function Survey(props: SurveyProps): ReactElement {
  const {
    event,
    mode,
    property = "value",
    className,
    hostedAnswer = true,
    hrefFor,
  } = props;

  if (
    process.env.NODE_ENV !== "production" &&
    RESERVED_PREFIXES.some((p) => event.startsWith(p))
  ) {
    // The engine link-rewriter is the authority — it REJECTS this at send time.
    console.warn(
      `[Survey] event "${event}" uses a reserved namespace (${RESERVED_PREFIXES.join(
        ", ",
      )}); the engine will reject it at send time.`,
    );
  }

  const hrefForValue = (value: SurveyOptionValue): string => {
    if (hrefFor) return hrefFor(value as string | number);
    return hostedAnswer ? HOSTED_ANSWER_HREF : "#";
  };

  const options = buildOptions(props);
  const isScaleLike = mode === "scale" || mode === "nps";

  const nodes: ReactNode[] = [];

  if (isScaleLike && props.minLabel) {
    nodes.push(
      createElement(
        "span",
        { key: "__min-label", "data-hs-survey-min-label": "" },
        props.minLabel,
      ),
    );
  }

  for (const [i, opt] of options.entries()) {
    nodes.push(
      createElement(
        EmailAction,
        {
          key: `${property}-${String(opt.value)}-${i}`,
          href: hrefForValue(opt.value),
          event,
          properties: { [property]: opt.value },
          ...(className ? { className } : {}),
        },
        opt.label,
      ),
    );
  }

  if (isScaleLike && props.maxLabel) {
    nodes.push(
      createElement(
        "span",
        { key: "__max-label", "data-hs-survey-max-label": "" },
        props.maxLabel,
      ),
    );
  }

  return createElement("div", { "data-hs-survey": mode }, ...nodes);
}
