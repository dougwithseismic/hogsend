"use client";

/**
 * `<SurveyBlockView>` — the in-app renderer for a `survey` {@link FeedBlock}.
 * One component covers rating (`scale`), `nps`, `yesno`, and `choice`: it draws
 * the option row, captures the answer, and confirms it inline.
 *
 * Override surface (matches `FeedItemView`/`ToastView`):
 *   1. `--hs-survey-*` CSS vars
 *   2. `className` + per-slot `classNames={{ root, prompt, options, option,
 *      optionSelected, thanks }}`
 *   3. `data-*` state (`data-mode`, `data-answered`, `data-value`; per option
 *      `data-selected` + `data-value`)
 *   4. `asChild` → Slot merges our props onto the consumer's element
 *   5. `renderSurvey` replaces the whole rendered survey
 *
 * Closed loop (the engine "write-back path" — reuses the EXISTING spine, NO new
 * write route): on select we `client.capture(event, …)` FIRST (fire-and-forget,
 * BEFORE the optimistic local mutation) so the journey trigger lands even on
 * navigation, then optimistically render the thanks line, then mark the host
 * item read, then call the consumer `onAnswer`. The answer lands in
 * `user_events.properties` exactly like an email semantic-click answer, so a
 * journey reads it via `ctx.waitForEvent → properties` with no special casing.
 * The shared `idempotencyKey` makes it exactly-once against re-answers.
 */

import type {
  FeedBlock,
  FeedItem as FeedItemData,
  Properties,
} from "@hogsend/js";
import {
  forwardRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import { cn } from "../../lib/cn.js";
import { dataVariants } from "../../lib/variants.js";
import { HogsendContext } from "../../provider/context.js";
import { HogsendFeedContext } from "../../provider/feed-context.js";
import { Slot } from "../primitives/slot.js";

/**
 * The `survey` member of the shared `FeedBlock` union, narrowed from
 * `@hogsend/js` (already a dependency) so this shape can't drift from the wire.
 */
export type SurveyBlock = Extract<FeedBlock, { type: "survey" }>;

/** A single chosen answer's scalar value. */
type SurveyAnswer = string | number | boolean;

/** Per-slot class overrides for {@link SurveyBlockView}. */
export interface SurveyBlockClassNames {
  root?: string;
  prompt?: string;
  options?: string;
  option?: string;
  optionSelected?: string;
  thanks?: string;
}

/** Props for {@link SurveyBlockView}. */
export interface SurveyBlockProps {
  /** The host feed item (for its id + mark-read). */
  item: FeedItemData;
  /** The narrowed survey block to render. */
  block: SurveyBlock;
  /** Merge props onto a consumer element (override layer 4). */
  asChild?: boolean;
  className?: string;
  classNames?: SurveyBlockClassNames;
  /** Replace the whole rendered survey (override layer 5). */
  renderSurvey?: (state: {
    block: SurveyBlock;
    answered: boolean;
    answer?: string | number;
    onAnswer: (v: string | number) => void;
  }) => ReactNode;
  /** Fired AFTER capture + optimistic mark (the consumer hook). */
  onAnswer?: (answer: string | number) => void;
}

const DEFAULT_FEED_ID = "in_app";

/** Build the ordered option list for a survey mode (mirrors the email side). */
function buildOptions(
  block: SurveyBlock,
): { label: string; value: SurveyAnswer }[] {
  if (block.mode === "yesno") {
    return (
      block.choices ?? [
        { label: "Yes", value: true },
        { label: "No", value: false },
      ]
    );
  }
  if (block.mode === "choice") return block.choices ?? [];
  const isNps = block.mode === "nps";
  const min = isNps ? 0 : (block.min ?? 1);
  const max = isNps ? 10 : (block.max ?? 5);
  const out: { label: string; value: SurveyAnswer }[] = [];
  for (let v = min; v <= max; v += 1) out.push({ label: String(v), value: v });
  return out;
}

export const SurveyBlockView = forwardRef<HTMLDivElement, SurveyBlockProps>(
  function SurveyBlockView(props, ref) {
    const {
      item,
      block,
      asChild = false,
      className,
      classNames,
      renderSurvey,
      onAnswer,
    } = props;

    const ctx = useContext(HogsendContext);
    if (!ctx) {
      throw new Error("SurveyBlockView must be used within <HogsendProvider>");
    }
    const client = ctx.client;
    const feedCtx = useContext(HogsendFeedContext);
    // Resolve the host feed without the side-effecting `useHogsendFeed` hook —
    // constructing the cached feed client is pure; we only need `markAsRead`.
    const feedId = feedCtx?.feedId ?? item.category ?? DEFAULT_FEED_ID;
    const feedClient = useMemo(() => client.feed(feedId), [client, feedId]);

    const [answer, setAnswer] = useState<SurveyAnswer | undefined>(undefined);
    const answered = answer !== undefined;
    const property = block.property ?? "value";

    const onAnswerInternal = (value: SurveyAnswer): void => {
      // (1) closed-loop capture FIRST (fire-and-forget, BEFORE local mutation)
      // so the journey trigger lands even if the consumer navigates away. The
      // shared idempotency key makes a re-answer exactly-once on the spine.
      const eventProps: Properties = {
        [property]: value,
        ...(block.surveyId ? { surveyId: block.surveyId } : {}),
        feedItemId: item.id,
        source: "in_app",
      };
      void client.capture(block.event, eventProps, {
        idempotencyKey: `inapp:survey:${item.id}:${block.event}`,
      });
      // (2) optimistic local state → render the thanks line
      setAnswer(value);
      // (3) answering reads the item
      void feedClient.markAsRead([item.id]);
      // (4) the consumer hook
      onAnswer?.(value as string | number);
    };

    const stateAttrs = dataVariants({
      mode: block.mode,
      answered,
      value: answered ? String(answer) : undefined,
    });

    const options = useMemo(() => buildOptions(block), [block]);

    // Keep survey interactions self-contained: a click/Enter/Space on an option
    // must NOT bubble to the host row's click (which would mark-read + fire the
    // consumer's `onItemClick`, possibly navigating away mid-answer). Both
    // handlers live on the (interactive) buttons, which own their own activation.
    const stopRowClick = (e: MouseEvent): void => e.stopPropagation();
    const stopRowKeys = (e: KeyboardEvent): void => {
      if (e.key === "Enter" || e.key === " ") e.stopPropagation();
    };

    const inner = renderSurvey ? (
      renderSurvey({
        block,
        answered,
        answer: answer as string | number | undefined,
        onAnswer: onAnswerInternal as (v: string | number) => void,
      })
    ) : (
      <>
        {block.prompt ? (
          <div className={cn("hsr-survey__prompt", classNames?.prompt)}>
            {block.prompt}
          </div>
        ) : null}
        <div className={cn("hsr-survey__options", classNames?.options)}>
          {options.map((opt) => {
            const selected = answered && String(answer) === String(opt.value);
            return (
              <button
                key={`${opt.label}:${String(opt.value)}`}
                type="button"
                className={cn(
                  "hsr-survey__option",
                  classNames?.option,
                  selected ? classNames?.optionSelected : undefined,
                )}
                data-selected={selected ? "" : undefined}
                data-value={String(opt.value)}
                aria-pressed={selected}
                disabled={answered}
                onKeyDown={stopRowKeys}
                onClick={(e) => {
                  stopRowClick(e);
                  onAnswerInternal(opt.value);
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        {answered ? (
          <div
            className={cn("hsr-survey__thanks", classNames?.thanks)}
            role="status"
          >
            Thanks for your feedback.
          </div>
        ) : null}
      </>
    );

    const sharedProps = {
      ...stateAttrs,
      className: cn("hsr-survey", className, classNames?.root),
    } as const;

    if (asChild) {
      return (
        <Slot ref={ref} {...sharedProps}>
          {inner as ReactNode}
        </Slot>
      );
    }

    return (
      <div ref={ref} {...sharedProps}>
        {inner}
      </div>
    );
  },
);
