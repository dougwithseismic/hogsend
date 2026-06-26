import type { FeedBlock } from "@hogsend/db";
import { type SendFeedItemResult, sendFeedItem } from "./feed.js";

/** The survey block's own fields (event/mode/property/…), minus the discriminant. */
type SurveyBlockFields = Omit<Extract<FeedBlock, { type: "survey" }>, "type">;

/**
 * Options for {@link sendSurvey} — the producer sugar that drops a `survey`
 * feed block into a recipient's in-app feed. Thin over {@link sendFeedItem}, so
 * it inherits the full pipeline (recipient resolution, `in_app` suppression,
 * replay-safe idempotency, Redis realtime publish).
 */
export interface SendSurveyOptions extends SurveyBlockFields {
  recipient: { userId?: string; email?: string; anonymousId?: string };
  title?: string;
  category?: string;
  idempotencyKey?: string;
  idempotencyLabel?: string;
}

/**
 * Journey-callable in-app survey send — producer sugar over {@link sendFeedItem}.
 * Builds a single `survey` feed block from `opts` and delegates, so the in-app
 * survey/rating primitive gets the SAME exactly-once replay-safety and `in_app`
 * suppression as any other feed send. The answer the recipient picks is captured
 * onto the spine by `<SurveyBlockView>` and lands in `user_events` — readable by
 * a journey via `ctx.waitForEvent → properties` and by
 * `GET /v1/admin/reporting/breakdown`.
 */
export function sendSurvey(
  opts: SendSurveyOptions,
): Promise<SendFeedItemResult> {
  const {
    recipient,
    title,
    category,
    idempotencyKey,
    idempotencyLabel,
    ...survey
  } = opts;
  return sendFeedItem({
    recipient,
    type: "survey",
    ...(title !== undefined ? { title } : {}),
    blocks: [{ type: "survey", ...survey }],
    ...(category !== undefined ? { category } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(idempotencyLabel !== undefined ? { idempotencyLabel } : {}),
  });
}
