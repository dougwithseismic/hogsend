import assert from "node:assert/strict";
import test from "node:test";
import type {
  BucketTriggerRef,
  JourneyMetaInput,
  JourneyTriggerInput,
} from "@hogsend/core/types";
import { type DefinedBucket, defineBucket } from "../buckets/define-bucket.js";
import { defineJourney } from "./define-journey.js";

/**
 * Runtime stand-in for a real bucket — only `entered` is read at the desugar
 * seam, so the cases about the seam ITSELF do not need a whole bucket. A
 * genuine `defineBucket` object goes through the same seam below, which is what
 * pins the field to the one a real bucket exposes.
 */
const powerUsers = { entered: "bucket:entered:power-users" } as const;

const BASE = {
  id: "dj-trigger",
  name: "Trigger",
  enabled: true,
  entryLimit: "once",
  suppress: {},
} satisfies Omit<JourneyMetaInput, "trigger">;

const run = async () => {};

test("a bucket trigger desugars to the bucket's entered event", () => {
  const j = defineJourney({
    meta: { ...BASE, trigger: { bucket: powerUsers } },
    run,
  });
  assert.equal(j.meta.trigger.event, "bucket:entered:power-users");
  // The STORED meta must stay the plain shape everything downstream reads —
  // no second trigger concept leaks into the registry/Hatchet/Studio.
  assert.deepEqual(Object.keys(j.meta.trigger), ["event"]);
});

test("desugared and hand-authored triggers are the same journey", () => {
  const sugared = defineJourney({
    meta: { ...BASE, trigger: { bucket: powerUsers } },
    run,
  });
  const literal = defineJourney({
    meta: { ...BASE, trigger: { event: "bucket:entered:power-users" } },
    run,
  });
  assert.deepEqual(sugared.meta, literal.meta);
  assert.equal(sugared.meta.versionHash, literal.meta.versionHash);
});

test("a bucket trigger still resolves a builder `where`", () => {
  const j = defineJourney({
    meta: {
      ...BASE,
      trigger: {
        // `where` narrows on the TRANSITION EVENT's payload, not the person's
        // properties — `source` is one of the keys emitBucketTransition
        // actually puts on the bag. A person predicate here (`plan`) would
        // compile and enroll nobody, forever; that misconception does not get
        // to live in the canonical example.
        bucket: powerUsers,
        where: (b) => b.prop("source").eq("manual"),
      },
    },
    run,
  });
  assert.equal(j.meta.trigger.event, "bucket:entered:power-users");
  assert.deepEqual(j.meta.trigger.where, [
    { type: "property", property: "source", operator: "eq", value: "manual" },
  ]);
});

test("declaring BOTH event and bucket throws", () => {
  assert.throws(
    () =>
      defineJourney({
        meta: {
          ...BASE,
          // A JS caller (or a widened `any`) reaches the seam untyped; the
          // union already rejects this at compile time — see the type block.
          trigger: {
            event: "user.created",
            bucket: powerUsers,
          } as unknown as JourneyTriggerInput,
        },
        run,
      }),
    /BOTH `event`.*and `bucket`/s,
  );
});

test("declaring NEITHER event nor bucket throws", () => {
  assert.throws(
    () =>
      defineJourney({
        meta: { ...BASE, trigger: {} as unknown as JourneyTriggerInput },
        run,
      }),
    /neither `event` nor `bucket`/,
  );
});

// `null` is not `undefined`, so a JS caller passing an explicitly-null bucket
// used to slip past both guards and die on `bucket.entered` — a raw TypeError
// raised while building the very diagnostic meant to catch it. Both shapes must
// reach the friendly error instead.
test("an explicitly null bucket reaches the diagnostic, not a TypeError", () => {
  assert.throws(
    () =>
      defineJourney({
        meta: {
          ...BASE,
          trigger: { bucket: null } as unknown as JourneyTriggerInput,
        },
        run,
      }),
    /neither `event` nor `bucket`/,
  );
  // A null bucket means ABSENT, so it is not the illegal both-keys case: the
  // event stands on its own rather than tripping the exclusivity guard.
  const j = defineJourney({
    meta: {
      ...BASE,
      trigger: { event: "a", bucket: null } as unknown as JourneyTriggerInput,
    },
    run,
  });
  assert.equal(j.meta.trigger.event, "a");
});

test("a bucket without an entered transition ref throws", () => {
  assert.throws(
    () =>
      defineJourney({
        meta: {
          ...BASE,
          trigger: { bucket: {} as unknown as BucketTriggerRef },
        },
        run,
      }),
    /no `entered` transition ref/,
  );
});

test("a ref whose `entered` is not a bucket transition throws", () => {
  assert.throws(
    () =>
      defineJourney({
        meta: {
          ...BASE,
          // The exact JS-caller shape the type rejects: a plausible-looking
          // ref bound to an event no bucket ever emits.
          trigger: {
            bucket: { entered: "user.created" } as unknown as BucketTriggerRef,
          },
        },
        run,
      }),
    /not a `bucket:entered:` transition ref/,
  );
});

test("a real defineBucket object drives the trigger", () => {
  // The stand-in above only proves the seam reads SOME `entered`. This proves
  // it reads the one a genuine bucket actually exposes — if `entered` ever
  // moved behind a getter, changed prefix, or stopped being derived at
  // construction, every bucket-triggered journey in production would break
  // while a hand-rolled literal kept the rest of this file green.
  const bucket = defineBucket({
    meta: { id: "power-users", name: "Power users", enabled: true },
  });
  const j = defineJourney({
    meta: { ...BASE, trigger: { bucket } },
    run,
  });
  assert.equal(j.meta.trigger.event, "bucket:entered:power-users");
});

// ---------------------------------------------------------------------------
// Type-level guards. These have no runtime assertions on purpose: they fail the
// build (`pnpm check-types`), which is the point — the reference the compiler
// resolves is the entire advantage this form has over naming the event.
//
// Every assertion below routes through `JourneyTriggerInput` itself (via
// `Accepts`), never through a helper declared in this file: an assertion about
// a local alias of the seam would stay green while the seam widened to
// `unknown` underneath it.
// ---------------------------------------------------------------------------

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;
type Accepts<T> = T extends JourneyTriggerInput ? true : false;

// defineBucket's `entered` is a literal, not a widened string — the whole
// reason handing over the object beats naming the event.
type _EnteredIsLiteral = Expect<
  Equals<DefinedBucket<"power-users">["entered"], "bucket:entered:power-users">
>;

// A real DefinedBucket satisfies the structural trigger ref…
type _BucketAccepted = Expect<
  Accepts<{ bucket: DefinedBucket<"power-users"> }>
>;
// …and so does the bare shape the ref documents, so the seam is satisfiable
// without importing the engine (core cannot name DefinedBucket).
type _RefShapeAccepted = Expect<Accepts<{ bucket: BucketTriggerRef }>>;

// The point of the literal: an arbitrary string is NOT a bucket, whether it is
// a plausible event name, a runtime-computed string, or the transition ref
// misspelled. Each of these compiles the moment `entered` widens to `string`.
type _ArbitraryEventRejected = Expect<
  Equals<Accepts<{ bucket: { entered: "user.created" } }>, false>
>;
type _RuntimeStringRejected = Expect<
  Equals<Accepts<{ bucket: { entered: string } }>, false>
>;
type _MisspelledPrefixRejected = Expect<
  Equals<Accepts<{ bucket: { entered: "bucket:enter:power-users" } }>, false>
>;
// A `left` ref is a real bucket field, and the likeliest wrong one to reach
// for; only `entered` triggers enrollment.
type _LeftRefRejected = Expect<
  Equals<Accepts<{ bucket: { left: DefinedBucket<"at-risk">["left"] } }>, false>
>;

// The two ambiguous shapes are rejected before runtime ever sees them.
type _BothRejected = Expect<
  Equals<
    Accepts<{ event: string; bucket: DefinedBucket<"power-users"> }>,
    false
  >
>;
type _NeitherRejected = Expect<Equals<Accepts<{ where: [] }>, false>>;
