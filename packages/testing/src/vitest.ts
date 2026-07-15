import { expect } from "vitest";
import type { JourneyMailbox } from "./mailbox.js";
import type { MailboxMessage } from "./types.js";

type MailboxLike =
  | JourneyMailbox
  | MailboxMessage[]
  | { messages: MailboxMessage[] };

const messagesOf = (received: MailboxLike): MailboxMessage[] => {
  if (Array.isArray(received)) return received;
  if (received && Array.isArray(received.messages)) return received.messages;
  throw new TypeError("Expected a JourneyMailbox or mailbox message array");
};

const partial = (actual: unknown, expected: unknown): boolean => {
  if (Object.is(actual, expected)) return true;
  if (!expected || typeof expected !== "object") return false;
  if (!actual || typeof actual !== "object") return false;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.every((item, index) => partial(actual[index], item))
    );
  }
  return Object.entries(expected as Record<string, unknown>).every(
    ([key, value]) => partial((actual as Record<string, unknown>)[key], value),
  );
};

export const journeyMatchers = {
  toHaveSent(
    received: MailboxLike,
    template: string,
    expected?: Partial<MailboxMessage>,
  ) {
    const messages = messagesOf(received);
    const pass = messages.some(
      (message) =>
        message.template === template &&
        (!expected || partial(message, expected)),
    );
    return {
      pass,
      message: () =>
        pass
          ? `Expected mailbox not to have sent "${template}"${expected ? " matching the supplied partial" : ""}`
          : `Expected mailbox to have sent "${template}"${expected ? " matching the supplied partial" : ""}. Sent: ${messages.map((item) => `${item.channel}:${item.template}`).join(", ") || "(none)"}`,
    };
  },
  toHaveSentTimes(received: MailboxLike, template: string, count: number) {
    const actual = messagesOf(received).filter(
      (message) => message.template === template,
    ).length;
    return {
      pass: actual === count,
      message: () =>
        `Expected mailbox ${actual === count ? "not " : ""}to have sent "${template}" ${count} time(s), received ${actual}`,
    };
  },
};

export function installJourneyMatchers(): void {
  expect.extend(journeyMatchers);
}

installJourneyMatchers();

declare module "vitest" {
  // `any` matches Vitest's declaration and is required for interface merging.
  // biome-ignore lint/suspicious/noExplicitAny: declaration-merging contract
  interface Matchers<T = any> {
    toHaveSent(template: string, expected?: Partial<MailboxMessage>): T;
    toHaveSentTimes(template: string, count: number): T;
  }
}
