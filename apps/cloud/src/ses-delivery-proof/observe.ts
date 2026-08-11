import { inArray } from "drizzle-orm";
import type { CloudDb } from "../db";
import { emailEvents } from "../db/schema";
import type { ProofScenario } from "./guards";

/**
 * Watch the `email_events` table for the rows this run's sends must produce.
 *
 * The table is polled rather than the ingress being hooked, because the whole
 * point is that a SEPARATE process (the dev control plane, behind the tunnel)
 * writes those rows — the script observing anything closer to itself would be
 * observing itself. Correlation is by SES MESSAGE ID: each simulator send
 * returned one, the notification carries it back, and the ingress records it
 * on the row. The `+<runId>` recipient label is the human-readable
 * cross-check, not the join key.
 *
 * A row is settled when its status leaves `pending` — `delivered`, `dropped`
 * and `failed` are all ANSWERS, and which one it is belongs in the report, not
 * in this loop's exit condition. The deadline exists because "the event never
 * came" is itself a finding, and a proof that waits forever reports nothing.
 */

export interface ExpectedEvent {
  scenario: ProofScenario;
  recipient: string;
  messageId: string;
  /** The relay type the ingress must normalize this scenario to. */
  expectedType: string;
}

export interface ObservedEvent extends ExpectedEvent {
  arrived: boolean;
  type: string | null;
  status: string | null;
  attempts: number | null;
  lastError: string | null;
  typeMatches: boolean;
}

export const DEFAULT_POLL_INTERVAL_MS = 3_000;

export async function observeEmailEvents(input: {
  db: CloudDb;
  expected: ExpectedEvent[];
  deadlineMs: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Injected clock (ms), so a deadline test does not actually wait. */
  now?: () => number;
}): Promise<ObservedEvent[]> {
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? (() => Date.now());
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startedAt = now();
  const messageIds = input.expected.map((event) => event.messageId);

  let rows: (typeof emailEvents.$inferSelect)[] = [];
  for (;;) {
    rows = await input.db
      .select()
      .from(emailEvents)
      .where(inArray(emailEvents.messageId, messageIds));

    const settled = input.expected.every((event) => {
      const row = rows.find(
        (candidate) => candidate.messageId === event.messageId,
      );
      return row !== undefined && row.status !== "pending";
    });
    if (settled || now() - startedAt >= input.deadlineMs) break;
    await sleep(pollIntervalMs);
  }

  return input.expected.map((event) => {
    const row = rows.find(
      (candidate) => candidate.messageId === event.messageId,
    );
    if (!row) {
      return {
        ...event,
        arrived: false,
        type: null,
        status: null,
        attempts: null,
        lastError: null,
        typeMatches: false,
      };
    }
    return {
      ...event,
      arrived: true,
      type: row.type,
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError,
      typeMatches: row.type === event.expectedType,
    };
  });
}
