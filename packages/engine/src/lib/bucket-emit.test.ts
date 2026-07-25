import assert from "node:assert/strict";
import test from "node:test";
import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { BucketMeta } from "@hogsend/core";
import type { JourneyRegistry } from "@hogsend/core/registry";
import type { Database } from "@hogsend/db";
import type { IngestEvent, ingestEvent } from "./ingestion.js";
import type { Logger } from "./logger.js";

// bucket-emit's import chain reaches env.ts (validates required env vars at
// import time) and lib/hatchet.ts (parses HATCHET_CLIENT_TOKEN as a JWT at
// import time) — stub both BEFORE the dynamic import. Nothing is ever
// contacted: the ingest seam intercepts everything. The token is the same
// well-formed dummy JWT apps/api's vitest config injects.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??= "test-secret";
process.env.HATCHET_CLIENT_TOKEN ??=
  "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test";
const { emitBucketTransition } = await import("./bucket-emit.js");

// ---------------------------------------------------------------------------
// Issue #608 — the `contactId` provenance pin. `emitBucketTransition`
// re-ingests every transition; `userId` is the contact's CANONICAL key
// (`external_id ?? anonymous_id ?? id`), but the resolver treats a bare
// `userId` as an EXTERNAL key, so an anonymous-only contact gets a phantom
// `external_id` twin minted per transition unless the pin rides the re-ingest.
// These tests assert at the `ingest` seam (no live DB — the Section 14
// pattern): the pin must ride BOTH re-ingests (per-bucket alias AND generic),
// and its absence must degrade to exactly the pin-less call shape.
// ---------------------------------------------------------------------------

const noop = () => {};
const logger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
} as unknown as Logger;

const bucket: BucketMeta = {
  id: "power-users",
  name: "Power users",
} as BucketMeta;

/** A registry stub with a journey bound to the generic `bucket:<kind>` form, so
 * the SECOND (generic) re-ingest actually fires and can be asserted on. */
function genericBoundRegistry(): JourneyRegistry {
  return {
    getByTriggerEvent: (event: string) =>
      event === "bucket:entered" || event === "bucket:left" ? [{}] : [],
  } as unknown as JourneyRegistry;
}

/** Recording ingest stub — captures each re-ingested event. */
function recordingIngest() {
  const events: IngestEvent[] = [];
  const ingest: typeof ingestEvent = async (opts) => {
    events.push(opts.event);
    return { stored: true, exits: [], contactKey: opts.event.userId ?? "" };
  };
  return { events, ingest };
}

// db/hatchet are never touched by the stubbed ingest; emitOutbound is
// fire-and-forget (`void ...catch(logger.warn)`) so its rejection on the empty
// db stub is swallowed by design.
const db = {} as Database;
const hatchet = {} as HatchetClient;

const CONTACT_ID = "9f3a1c2e-0000-4000-8000-000000000608";

test("entered: the contactId pin rides BOTH re-ingests (alias + generic)", async () => {
  const { events, ingest } = recordingIngest();

  await emitBucketTransition({
    db,
    registry: genericBoundRegistry(),
    hatchet,
    logger,
    kind: "entered",
    bucket,
    userId: "anon-608",
    userEmail: null,
    contactId: CONTACT_ID,
    epoch: 1,
    ingest,
  });

  assert.equal(events.length, 2);
  const [alias, generic] = events;
  assert.equal(alias?.event, "bucket:entered:power-users");
  assert.equal(generic?.event, "bucket:entered");
  // The pin on EACH leg — dropping it on either one leaves the phantom-twin
  // mint half-alive (issue #608).
  assert.equal(alias?.contactId, CONTACT_ID);
  assert.equal(generic?.contactId, CONTACT_ID);
});

test("left: the contactId pin rides the leave re-ingest too", async () => {
  const { events, ingest } = recordingIngest();

  await emitBucketTransition({
    db,
    registry: genericBoundRegistry(),
    hatchet,
    logger,
    kind: "left",
    bucket,
    userId: "anon-608",
    userEmail: null,
    contactId: CONTACT_ID,
    epoch: 2,
    reason: "criteria",
    ingest,
  });

  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.contactId, CONTACT_ID);
  }
});

test("no contactId: degrades to exactly the pin-less re-ingest", async () => {
  const { events, ingest } = recordingIngest();

  await emitBucketTransition({
    db,
    registry: genericBoundRegistry(),
    hatchet,
    logger,
    kind: "entered",
    bucket,
    userId: "anon-608",
    userEmail: null,
    epoch: 1,
    ingest,
  });

  // A producer with no resolved contact row in scope (e.g. the fast-expiry
  // timer) must NOT invent a pin — the resolver falls back to value keys.
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.contactId, undefined);
  }
});
