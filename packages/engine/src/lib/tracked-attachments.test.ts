import assert from "node:assert/strict";
import test from "node:test";
import type {
  EmailAttachment,
  EmailEvent,
  EmailProvider,
  EmailProviderCapabilities,
  SendEmailOptions,
} from "@hogsend/core";
import { MAX_ATTACHMENT_BYTES } from "@hogsend/core";
import { EmailAction, type TemplateRegistry } from "@hogsend/email";

// The engine's env contract is validated at module scope (lib/hatchet.ts pulls
// env.ts in through lib/tracked.ts), so these must be in place BEFORE the
// dynamic imports below. Nothing here reaches the network: the db is a fake,
// the provider is a fake, and Hatchet is only constructed, never called.
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
const { AttachmentsUnsupportedError } = await import("./attachments.js");
const { prepareTrackedHtml } = await import("./tracking.js");
const { sendEmail, setEmailService } = await import("./email.js");

const TEMPLATE = "welcome" as never;
const EMAIL_SEND_ID = "es_00000000-0000-4000-8000-000000000001";
const BASE_URL = "https://api.example.com";

/**
 * The registry the mailer renders through. `EmailAction` is imported rather
 * than a hand-written component so the element is built by the SAME React copy
 * `renderToHtml` renders with (the engine itself has no `react` dependency —
 * it is the consumer's peer). The absolute href gives `rewriteLinks` a real
 * anchor to rewrite, which the tracking-survival test asserts on.
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
 * A minimal chainable fake `db` (mirrors tracked-idempotency-header.test.ts).
 * Records EVERY `insert(...).values(...)` payload: the `email_sends` row is the
 * first insert; when the real `prepareTrackedHtml` runs, the `tracked_links`
 * bulk insert (an ARRAY payload) lands after it.
 */
function makeFakeDb() {
  const inserted: unknown[] = [];
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
      values: (values: unknown) => {
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
 * A fake provider that only records what it was handed. `capabilities` decides
 * whether attachments may travel — NEVER the id — so every test states it
 * explicitly. Default models a capable transport; pass `capabilities: {}` for
 * one that never declared `attachments` (absence is not consent).
 */
function makeFakeProvider(
  over: { id?: string; capabilities?: EmailProviderCapabilities } = {},
) {
  const id = over.id ?? "hogsend";
  const capabilities =
    "capabilities" in over ? over.capabilities : { attachments: true };
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
    // which this suite is about.
    skipPreferenceCheck: true,
    ...over,
  };
}

const PDF_SENTINEL = "%PDF-1.4 SENTINEL-BYTES-NEVER-STORED";

function pdfAttachment(): EmailAttachment {
  return {
    filename: "invoice.pdf",
    contentType: "application/pdf",
    content: new TextEncoder().encode(PDF_SENTINEL),
  };
}

test("a send with no attachments hands the provider options with NO attachments key", async () => {
  // The no-regression assertion for every existing send: not `attachments:
  // undefined`, the key simply is not there — the wire is byte-identical to
  // before this feature existed. The row grows no metadata either.
  const { db, inserted } = makeFakeDb();
  const { provider, sends } = makeFakeProvider();

  await sendTrackedEmail({ db, provider, registry, options: baseOptions() });

  assert.equal(sends.length, 1);
  assert.equal("attachments" in (sends[0] ?? {}), false);
  assert.equal(
    "metadata" in ((inserted[0] ?? {}) as Record<string, unknown>),
    false,
  );
});

test("attachments pass through to a provider that declares the capability", async () => {
  const { db } = makeFakeDb();
  const { provider, sends } = makeFakeProvider({
    capabilities: { attachments: true },
  });
  const attachment = pdfAttachment();

  await sendTrackedEmail({
    db,
    provider,
    registry,
    options: baseOptions({ attachments: [attachment] }),
  });

  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0]?.attachments, [attachment]);
});

test("tracking still applies with attachments present: links rewritten, pixel injected, files alongside", async () => {
  // THE locked ordering decision of PRD 17 task 6: tracking is applied FIRST
  // and the attachments ride alongside the TRACKED html on the same provider
  // call. An attachment must never cause tracking to be skipped — this runs
  // the REAL prepareTrackedHtml (rewriteLinks + injectOpenPixel), not a stub.
  const { db } = makeFakeDb();
  const { provider, sends } = makeFakeProvider({
    capabilities: { attachments: true },
  });
  const attachment = pdfAttachment();

  await sendTrackedEmail({
    db,
    provider,
    registry,
    prepareTrackedHtml,
    options: baseOptions({
      baseUrl: BASE_URL,
      attachments: [attachment],
    }),
  });

  assert.equal(sends.length, 1);
  const html = sends[0]?.html ?? "";
  // The template's absolute link was rewritten to the first-party redirect…
  assert.match(html, new RegExp(`${BASE_URL}/v1/t/c/`));
  assert.doesNotMatch(html, /https:\/\/example\.com\/welcome/);
  // …the open pixel was injected for THIS send…
  assert.match(html, new RegExp(`${BASE_URL}/v1/t/o/${EMAIL_SEND_ID}`));
  // …and the attachments travelled on the SAME wire call as the tracked html.
  assert.deepEqual(sends[0]?.attachments, [attachment]);
});

test("a provider without capabilities.attachments throws, naming the provider — BEFORE send and BEFORE any row", async () => {
  // Absence is not consent: a receipt delivered without its invoice looks
  // `sent` from every dashboard, so the engine must refuse loudly instead.
  // The fail-before-work assertions are the point — a throw AFTER the provider
  // call (or after the row insert) would record a send that must not exist.
  const { db, inserted } = makeFakeDb();
  const { provider, sends } = makeFakeProvider({
    id: "resend",
    capabilities: {},
  });

  await assert.rejects(
    sendTrackedEmail({
      db,
      provider,
      registry,
      options: baseOptions({ attachments: [pdfAttachment()] }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AttachmentsUnsupportedError);
      assert.match(error.message, /"resend"/);
      assert.match(error.message, /capabilities\.attachments/);
      return true;
    },
  );

  assert.equal(sends.length, 0);
  assert.equal(inserted.length, 0);
});

test("a CR/LF filename throws InvalidAttachmentError before the provider is called", async () => {
  const { db, inserted } = makeFakeDb();
  const { provider, sends } = makeFakeProvider({
    capabilities: { attachments: true },
  });

  await assert.rejects(
    sendTrackedEmail({
      db,
      provider,
      registry,
      options: baseOptions({
        attachments: [
          { filename: "invoice\r\n.pdf", content: new Uint8Array([1]) },
        ],
      }),
    }),
    (error: unknown) => {
      assert.equal((error as Error).name, "InvalidAttachmentError");
      assert.match((error as Error).message, /CR, LF or NUL/);
      return true;
    },
  );

  assert.equal(sends.length, 0);
  assert.equal(inserted.length, 0);
});

test("an over-cap attachment throws before the provider is called", async () => {
  const { db } = makeFakeDb();
  const { provider, sends } = makeFakeProvider({
    capabilities: { attachments: true },
  });

  await assert.rejects(
    sendTrackedEmail({
      db,
      provider,
      registry,
      options: baseOptions({
        attachments: [
          {
            filename: "huge.bin",
            content: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
          },
        ],
      }),
    }),
    (error: unknown) => {
      assert.equal((error as Error).name, "InvalidAttachmentError");
      return true;
    },
  );

  assert.equal(sends.length, 0);
});

test("email_sends records filename/size/contentType — and NEVER the content bytes", async () => {
  // Storing customer invoices indefinitely is a data-protection decision
  // nobody has made, so the absence of the bytes is asserted DELIBERATELY:
  // deepEqual pins the metadata to EXACTLY the three descriptive fields, and
  // the sentinel scan proves the payload text appears nowhere in the row. The
  // `{ base64 }` attachment additionally pins `sizeBytes` to the DECODED
  // length ("abcd" → 3 raw bytes), the same number the size cap enforces.
  const { db, inserted } = makeFakeDb();
  const { provider } = makeFakeProvider({
    capabilities: { attachments: true },
  });

  await sendTrackedEmail({
    db,
    provider,
    registry,
    options: baseOptions({
      attachments: [
        pdfAttachment(),
        { filename: "export.csv", content: { base64: "abcd" } },
      ],
    }),
  });

  const row = (inserted[0] ?? {}) as Record<string, unknown>;
  const metadata = row.metadata as Record<string, unknown>;
  assert.deepEqual(metadata.attachments, [
    {
      filename: "invoice.pdf",
      sizeBytes: PDF_SENTINEL.length,
      contentType: "application/pdf",
    },
    { filename: "export.csv", sizeBytes: 3 },
  ]);
  // Belt and braces on the absence: no `content` key on any entry, and the
  // sentinel text is nowhere in the serialized row.
  for (const entry of metadata.attachments as Record<string, unknown>[]) {
    assert.equal("content" in entry, false);
  }
  assert.equal(JSON.stringify(row).includes("SENTINEL"), false);
});

test("the sendEmail journey helper forwards attachments to the email service", async () => {
  // The authoring surface of task 5: `sendEmail({ ..., attachments })` must
  // hand the files to `service.send` exactly like every other option. No
  // journey boundary here — a plain forwarding check at the service seam.
  const received: Array<Record<string, unknown>> = [];
  setEmailService({
    send: async (options: unknown) => {
      received.push(options as Record<string, unknown>);
      return {
        emailSendId: EMAIL_SEND_ID,
        messageId: "msg_fake_1",
        resendId: "msg_fake_1",
        status: "sent",
      };
    },
  } as never);
  const attachment = pdfAttachment();

  await sendEmail({
    to: "user@example.com",
    userId: "user_1",
    template: TEMPLATE,
    attachments: [attachment],
  });

  assert.equal(received.length, 1);
  assert.deepEqual(received[0]?.attachments, [attachment]);
});
