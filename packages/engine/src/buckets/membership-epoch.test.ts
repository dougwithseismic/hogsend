import assert from "node:assert/strict";
import test from "node:test";
import type { BucketMeta } from "@hogsend/core";
import { minDwellDeadline } from "./membership-epoch.js";

// ---------------------------------------------------------------------------
// `minDwellDeadline` is the SHARED minDwell window kernel: the real-time leave
// (`check-membership.ts` handleLeave) and the explicit membership-mutation seam
// (`membership.ts` removeBucketMember) both key their defer decision on it. A
// divergence here would let one writer emit a leave the other defers, so the
// semantics are pinned directly. Pure (clock + arithmetic only) — no DB.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;

function bucketWith(minDwell?: BucketMeta["minDwell"]): BucketMeta {
  return { id: "b", name: "B", minDwell } as BucketMeta;
}

test("no minDwell configured: the leave may proceed now", () => {
  const active = { enteredAt: new Date() };
  assert.equal(minDwellDeadline(active, bucketWith(undefined)), null);
});

test("inside the window: returns enteredAt + minDwell (defer, never drop)", () => {
  const enteredAt = new Date(Date.now() - 1 * HOUR);
  const deadline = minDwellDeadline({ enteredAt }, bucketWith({ hours: 6 }));
  assert.ok(deadline instanceof Date);
  assert.equal(deadline.getTime(), enteredAt.getTime() + 6 * HOUR);
});

test("window elapsed: the leave may proceed now", () => {
  const enteredAt = new Date(Date.now() - 7 * HOUR);
  assert.equal(minDwellDeadline({ enteredAt }, bucketWith({ hours: 6 })), null);
});

test("boundary: a deadline exactly now is elapsed, not deferred", () => {
  // `elapsed < minDwell` — the strict inequality the original real-time leave
  // used. A member who entered EXACTLY minDwell ago leaves immediately rather
  // than being deferred by a zero-length window that would never resolve.
  const enteredAt = new Date(Date.now() - 6 * HOUR);
  assert.equal(minDwellDeadline({ enteredAt }, bucketWith({ hours: 6 })), null);
});
