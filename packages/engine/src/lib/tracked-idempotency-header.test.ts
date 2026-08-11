import assert from "node:assert/strict";
import test from "node:test";
import type {
  EmailEvent,
  EmailProvider,
  EmailProviderCapabilities,
  SendEmailOptions,
} from "@hogsend/core";
import { EmailAction, type TemplateRegistry } from "@hogsend/email";

// The engine's env contract is validated at module scope (lib/hatchet.ts pulls
// env.ts in through lib/tracked.ts), so these must be in place BEFORE the
// dynamic import below. Nothing here reaches the network: the db is a fake, the
// provider is a fake, and Hatchet is only constructed, never called.
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "error";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??=
  "test-secret-for-node-test-minimum-32-characters-long";
// A structurally-valid but inert Hatchet token (the same fixture apps/api's
// vitest config uses). The client is constructed at import; it never dials.
process.env.HATCHET_CLIENT_TOKEN ??=
  "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test";

const { sendTrackedEmail } = await import("./tracked.js");
const { createRecordingBoundary } = await import(
  "../journeys/durable-law-harness.js"
);
const { deriveJourneyKey, runWithJourneyBoundary } = await import(
  "../journeys/journey-boundary.js"
);

const TEMPLATE = "welcome" as never;
const EMAIL_SEND_ID = "es_00000000-0000-4000-8000-000000000001";

/**
 * The registry the mailer renders through. `EmailAction` is imported rather than
 * a hand-written component so the element is built by the SAME React copy
 * `renderToHtml` renders with (the engine itself has no `react` dependency —
 * it is the consumer's peer).
 */
const registry = {
  welcome: {
    component: () =>
      EmailAction({
        href: "https://example.com/welcome",
        event: "welcome.clicked",
        children: "Get started",
      }),
    defaultSubject: "Welcome",
  },
} as unknown as TemplateRegistry;

/**
 * A minimal chainable fake `db`. The tracked mailer's DB path here is: the
 * idempotency short-circuit SELECT (no prior row), the `email_sends` INSERT, and
 * the sent-status UPDATE. The fire-and-forget `emitOutbound` awaits its endpoint
 * SELECT directly (no `.limit()`), so the chain is thenable as well as
 * chainable, and resolves to zero endpoints — no outbound work, no network.
 */
function makeFakeDb() {
  const inserted: Array<Record<string, unknown>> = [];
  const chain = (result: unknown[]): Record<string, unknown> => {
    const self: Record<string, unknown> = {
      from: () => self,
      leftJoin: () => self,
      where: () => self,
      orderBy: () => self,
      limit: () => Promise.resolve(result),
      // A drizzle query builder IS thenable: `await db.select().from(t).where(c)`
      // with no terminal call is exactly the shape emitOutbound uses, so the
      // fake has to be thenable to model it.
      // biome-ignore lint/suspicious/noThenProperty: modelling a drizzle builder
      then: (resolve: (rows: unknown[]) => void) => resolve(result),
    };
    return self;
  };
  const returning = () => Promise.resolve([{ id: EMAIL_SEND_ID }]);
  const db = {
    select: () => chain([]),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return {
          onConflictDoNothing: () => ({ returning }),
          returning,
        };
      },
    }),
    update: () => ({
      set: () => ({ where: () => Promise.resolve() }),
    }),
  };
  return { db: db as never, inserted };
}

/**
 * A fake provider that only records what it was handed.
 *
 * `capabilities` is what decides whether the wire gets the key, NEVER the id —
 * so the fake takes the two independently and every test states both. The
 * default is the consuming posture (`consumesIdempotencyKey: true`); pass
 * `capabilities: {}` to model a header-forwarding transport (Resend, Postmark)
 * that must never be handed an internal key.
 */
function makeFakeProvider(
  over: { id?: string; capabilities?: EmailProviderCapabilities } = {},
) {
  const id = over.id ?? "hogsend";
  // `in`, not a destructuring default: an EXPLICIT `capabilities: undefined`
  // models the pre-registry provider shape (the field is optional on the
  // contract) and must NOT silently fall back to the consuming default.
  const capabilities =
    "capabilities" in over
      ? over.capabilities
      : { consumesIdempotencyKey: true };
  const sends: SendEmailOptions[] = [];
  const provider = {
    meta: { id, name: "Fake" },
    capabilities,
    send: async (options: SendEmailOptions) => {
      sends.push(options);
      return { id: "msg_fake_1" };
    },
    sendBatch: async () => ({ results: [] }),
    verifyWebhook: (): EmailEvent => {
      throw new Error("not used");
    },
    parseWebhook: (): EmailEvent => {
      throw new Error("not used");
    },
  } as unknown as EmailProvider;
  return { provider, sends };
}

function baseOptions(over: Record<string, unknown> = {}) {
  return {
    templateKey: TEMPLATE,
    props: {} as never,
    from: "Hogsend <noreply@example.com>",
    to: "user@example.com",
    // Skips suppression / control group / frequency cap / journey suppress, all
    // of which would need far more DB shape than this fake carries and none of
    // which this test is about.
    skipPreferenceCheck: true,
    ...over,
  };
}

/**
 * EVERY case-insensitive match, not the first. HTTP header names are
 * case-insensitive, so `Idempotency-Key` and `idempotency-key` on one message
 * are the SAME header twice — and the plugin's own reader takes the last one it
 * walks. A "first match" lookup would let a duplicate-under-different-casing bug
 * pass this suite while shipping the wrong key on the wire.
 */
function headerValues(
  headers: Record<string, string> | undefined,
  name: string,
): string[] {
  const lower = name.toLowerCase();
  return Object.entries(headers ?? {})
    .filter(([key]) => key.toLowerCase() === lower)
    .map(([, value]) => value);
}

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  const values = headerValues(headers, name);
  assert.ok(
    values.length <= 1,
    `expected at most one "${name}" header, got ${values.length}: ${values.join(", ")}`,
  );
  return values[0];
}

test("PRD 10 T4b: the derived replay-stable key reaches provider.send as Idempotency-Key", async () => {
  // THE test this task exists for. `@hogsend/plugin-hogsend` falls back to
  // hashing the message bytes when handed no key, and that fallback cannot
  // protect a crash replay: `prepareTrackedHtml` mints fresh `tracked_links` ids
  // and an open pixel carrying the send id on every attempt, so the same logical
  // send hashes differently each time. The relay's exactly-once guard is only as
  // good as the key it is handed — without this header a journey replayed after
  // a worker crash sends twice.
  const { db, inserted } = makeFakeDb();
  const { provider, sends } = makeFakeProvider();
  const { boundary } = createRecordingBoundary({
    runAnchor: "run-abc",
    currentLabel: "wait-for-activation",
  });

  await runWithJourneyBoundary(boundary, () =>
    sendTrackedEmail({
      db,
      provider,
      registry,
      options: baseOptions({ headers: { "X-Campaign": "spring" } }),
    }),
  );

  const expected = deriveJourneyKey({
    kind: "send",
    anchor: "run-abc",
    site: "wait-for-activation",
    discriminant: "welcome",
  });
  assert.equal(sends.length, 1);
  assert.equal(headerValue(sends[0]?.headers, "Idempotency-Key"), expected);
  // The SAME key on the wire as in the `email_sends` row. One key, both dedup
  // layers: if these ever diverge the relay is guarding a different send than
  // the database is, and a replay slips through whichever layer missed.
  assert.equal(inserted[0]?.idempotencyKey, expected);
  // The key is an ADDITION to the wire, not a replacement for it: caller headers
  // still travel alongside it.
  assert.equal(sends[0]?.headers?.["X-Campaign"], "spring");
});

for (const id of ["resend", "postmark"]) {
  test(`a header-forwarding provider (${id}) NEVER receives the auto-threaded key`, async () => {
    // Resend and Postmark forward `SendEmailOptions.headers` verbatim onto the
    // DELIVERED message, so threading the engine's key to them would stamp
    // internal identifiers — Hatchet run ids + wait labels on journey sends, the
    // recipient's own address on campaign sends — onto every outbound email of
    // every existing deploy. Neither declares `consumesIdempotencyKey`, and
    // ABSENCE IS NOT CONSENT: the gate strips the key from the WIRE only, so the
    // `email_sends` row still records it and the DB dedup layer is intact.
    const { db, inserted } = makeFakeDb();
    const { provider, sends } = makeFakeProvider({ id, capabilities: {} });
    const { boundary } = createRecordingBoundary({
      runAnchor: "run-abc",
      currentLabel: "wait-for-activation",
    });

    await runWithJourneyBoundary(boundary, () =>
      sendTrackedEmail({
        db,
        provider,
        registry,
        options: baseOptions({ headers: { "X-Campaign": "spring" } }),
      }),
    );

    assert.equal(sends.length, 1);
    assert.equal(headerValue(sends[0]?.headers, "Idempotency-Key"), undefined);
    // Layer 2 is unconditional: the row carries the derived key even though the
    // wire does not.
    assert.equal(
      inserted[0]?.idempotencyKey,
      deriveJourneyKey({
        kind: "send",
        anchor: "run-abc",
        site: "wait-for-activation",
        discriminant: "welcome",
      }),
    );
    // Caller headers still travel untouched.
    assert.equal(sends[0]?.headers?.["X-Campaign"], "spring");
  });
}

test("a provider NAMED `hogsend` that does not DECLARE the capability gets NO key", async () => {
  // The point of the whole PRD. The gate used to say yes to `meta.id ===
  // "hogsend"`, which meant one first-party package got a behaviour no third
  // party could opt into by writing correct code — and, worse, that a
  // regression where the package STOPS declaring the capability would be
  // invisible. The id is now inert: only the declaration speaks.
  const { db, inserted } = makeFakeDb();
  const { provider, sends } = makeFakeProvider({
    id: "hogsend",
    capabilities: { nativeTracking: false, signedWebhooks: true },
  });
  const { boundary } = createRecordingBoundary({
    runAnchor: "run-abc",
    currentLabel: "wait-for-activation",
  });

  await runWithJourneyBoundary(boundary, () =>
    sendTrackedEmail({ db, provider, registry, options: baseOptions() }),
  );

  assert.equal(sends.length, 1);
  assert.equal(headerValue(sends[0]?.headers, "Idempotency-Key"), undefined);
  // Layer 2 is untouched by the gate either way.
  assert.equal(
    inserted[0]?.idempotencyKey,
    deriveJourneyKey({
      kind: "send",
      anchor: "run-abc",
      site: "wait-for-activation",
      discriminant: "welcome",
    }),
  );
});

test("a NON-`hogsend` provider that DECLARES the capability DOES get the key", async () => {
  // The other half of the point: a third-party transport whose wire consumes
  // the header opts in by DECLARATION alone. No engine change, no name check,
  // no cast — it writes `consumesIdempotencyKey: true` and the key arrives.
  const { db, inserted } = makeFakeDb();
  const { provider, sends } = makeFakeProvider({
    id: "acme-relay",
    capabilities: { consumesIdempotencyKey: true },
  });
  const { boundary } = createRecordingBoundary({
    runAnchor: "run-abc",
    currentLabel: "wait-for-activation",
  });

  await runWithJourneyBoundary(boundary, () =>
    sendTrackedEmail({ db, provider, registry, options: baseOptions() }),
  );

  const expected = deriveJourneyKey({
    kind: "send",
    anchor: "run-abc",
    site: "wait-for-activation",
    discriminant: "welcome",
  });
  assert.equal(sends.length, 1);
  assert.equal(headerValue(sends[0]?.headers, "Idempotency-Key"), expected);
  assert.equal(inserted[0]?.idempotencyKey, expected);
});

test("`consumesIdempotencyKey: false` is a NO, exactly like omitting it", async () => {
  const { db } = makeFakeDb();
  const { provider, sends } = makeFakeProvider({
    id: "acme-relay",
    capabilities: { consumesIdempotencyKey: false },
  });
  const { boundary } = createRecordingBoundary({
    runAnchor: "run-abc",
    currentLabel: "wait-for-activation",
  });

  await runWithJourneyBoundary(boundary, () =>
    sendTrackedEmail({ db, provider, registry, options: baseOptions() }),
  );

  assert.equal(headerValue(sends[0]?.headers, "Idempotency-Key"), undefined);
});

test("a provider with NO `capabilities` at all gets no key (absence is not consent)", async () => {
  // The pre-registry provider shape: `capabilities` is optional on the
  // contract, so the gate has to read through an absent object without
  // throwing and without defaulting to yes.
  const { db } = makeFakeDb();
  const { provider, sends } = makeFakeProvider({
    id: "hogsend",
    capabilities: undefined,
  });
  const { boundary } = createRecordingBoundary({
    runAnchor: "run-abc",
    currentLabel: "wait-for-activation",
  });

  await runWithJourneyBoundary(boundary, () =>
    sendTrackedEmail({ db, provider, registry, options: baseOptions() }),
  );

  assert.equal(headerValue(sends[0]?.headers, "Idempotency-Key"), undefined);
});

test("an EXPLICIT caller Idempotency-Key header passes through to any provider", async () => {
  // Pre-threading behavior, preserved: a header the caller placed in
  // `options.headers` themselves is a deliberate choice, not the engine's —
  // the gate never strips it, even for a header-forwarding provider that
  // declares nothing.
  const { db } = makeFakeDb();
  const { provider, sends } = makeFakeProvider({
    id: "resend",
    capabilities: {},
  });

  await sendTrackedEmail({
    db,
    provider,
    registry,
    options: baseOptions({ headers: { "Idempotency-Key": "caller-explicit" } }),
  });

  assert.equal(
    headerValue(sends[0]?.headers, "Idempotency-Key"),
    "caller-explicit",
  );
});

test("a caller-supplied idempotency key reaches the provider too", async () => {
  // POST /v1/emails threads its own key. Same header, no journey required.
  const { db } = makeFakeDb();
  const { provider, sends } = makeFakeProvider();

  await sendTrackedEmail({
    db,
    provider,
    registry,
    options: baseOptions({ idempotencyKey: "caller-key-1" }),
  });

  assert.equal(
    headerValue(sends[0]?.headers, "Idempotency-Key"),
    "caller-key-1",
  );
});

test("no idempotency key → no Idempotency-Key header is invented", async () => {
  // A journeyless send with no caller key has nothing replay-stable to say, and
  // a fabricated key would be worse than none: the provider's own fallback is at
  // least derived from the message. The header must simply be absent.
  const { db } = makeFakeDb();
  const { provider, sends } = makeFakeProvider();

  await sendTrackedEmail({ db, provider, registry, options: baseOptions() });

  assert.equal(headerValue(sends[0]?.headers, "Idempotency-Key"), undefined);
});

test("an explicit Idempotency-Key header from the caller is never clobbered", async () => {
  const { db } = makeFakeDb();
  const { provider, sends } = makeFakeProvider();

  await sendTrackedEmail({
    db,
    provider,
    registry,
    options: baseOptions({
      idempotencyKey: "derived-key",
      headers: { "idempotency-key": "explicit-key" },
    }),
  });

  assert.equal(
    headerValue(sends[0]?.headers, "Idempotency-Key"),
    "explicit-key",
  );
});
