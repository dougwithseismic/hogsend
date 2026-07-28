import assert from "node:assert/strict";
import test from "node:test";
import type {
  EmailHistoryOptions,
  SmsHistoryOptions,
} from "@hogsend/core/types";

/**
 * The AUGMENTED-BUT-EMPTY half of the read-path narrowing contract.
 *
 * Be precise about which of the two fallback states this file covers, because
 * the two are easy to conflate and only one of them is reachable from here.
 * The engine LOADS `template-key-augmentation.ts`, so the carrier does have a
 * `key` in this program — it is `keyof TemplateRegistryMap`, which is `never`
 * because the engine registers no templates of its own. That is exactly the
 * state of a freshly scaffolded consumer who has not authored their first
 * email yet, and the narrowed type MUST widen back to `string` there or such a
 * consumer cannot call `ctx.history.email` at all. So this pins the INNER
 * `[K] extends [never] ? string` branch and nothing else.
 *
 * The other state — no carrier `key` whatsoever, i.e. `@hogsend/core` used
 * without the engine — is unreachable in any engine program and is pinned
 * instead by `packages/core/src/types/journey-context.test.ts`, the only
 * program in the repo with no augmentation. The mirror guard — that a typo IS
 * rejected once a consumer HAS registered templates — lives in
 * `apps/api/src/__tests__/history-events.test.ts`.
 *
 * This is a TYPE-level guard: it fails under `check-types`, not at runtime.
 */
test("history template keys widen to string with no templates registered", () => {
  const emailKey: EmailHistoryOptions["template"] = "any-email-key";
  const smsKey: SmsHistoryOptions["template"] = "any-sms-key";

  assert.equal(emailKey, "any-email-key");
  assert.equal(smsKey, "any-sms-key");
});
