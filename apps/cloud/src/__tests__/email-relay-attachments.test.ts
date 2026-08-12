import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { environments, organizations } from "../db/schema";
import { env } from "../env";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
} from "../lib/email-attachments";
import {
  handleRelaySend,
  handleRelaySendBatch,
  MAX_BATCH_REQUEST_BYTES,
  MAX_SEND_REQUEST_BYTES,
  type RelayBatchResult,
} from "../lib/email-relay";
import { RelayTokenService } from "../services/relay-tokens";
import { FakeSesClient } from "../ses/fake";
import { resetSesClients } from "../ses/index";
import { sesConfigurationSetName, sesTenantName } from "../ses/names";
import type { SesSendBatchInput, SesSendEmailInput } from "../ses/types";
import {
  BINARY_FIXTURE,
  BINARY_FIXTURE_BASE64,
  BINARY_FIXTURE_NON_ASCII,
  countNonAscii,
} from "./helpers/binary-attachment";

/**
 * Attachments through the relay, and the size gate in front of them (PRD 17
 * task 4).
 *
 * Every "was SES touched" assertion reads the FAKE'S CALL LOG, never the
 * response body — a gate that refuses AFTER calling SES would produce the same
 * 400 and be worthless, and only the counter can tell the two apart.
 *
 * The numbers asserted here are the hand-synced mirrors in
 * `lib/email-attachments.ts` (values identical to `@hogsend/core`'s), so a
 * drift between the two contracts shows up as a failing literal, not silently.
 */

const ORG = "email-relay-attachments-test-org";
const tokens = new RelayTokenService(db);

const DOMAIN = "acme.test";
const IDENTITY_ARN = `arn:aws:ses:us-east-1:000000000000:identity/${DOMAIN}`;

let seq = 0;

interface Fixture {
  environmentId: string;
  token: string;
  ses: FakeSesClient;
  tenantName: string;
}

/** The state a fully provisioned environment is in — see the send suite. */
async function makeSendReady(
  ses: FakeSesClient,
  tenantName: string,
): Promise<void> {
  await ses.createTenant({ tenantName });
  if (!ses.calls.some((call) => call.method === "createIdentity")) {
    await ses.createIdentity({ domain: DOMAIN });
    ses.__verifyIdentity(DOMAIN);
  }
  await ses.associateResource({ tenantName, resourceArn: IDENTITY_ARN });
}

async function seed(): Promise<Fixture> {
  seq += 1;
  const [row] = await db
    .insert(environments)
    .values({
      organizationId: ORG,
      name: `relay-attachments-${seq}`,
      kind: "test",
    })
    .returning();
  if (!row) throw new Error("failed to seed environment");
  const { token } = await tokens.mint({ environmentId: row.id });
  const ses = new FakeSesClient({ region: "us" });
  const tenantName = sesTenantName(row.id);
  await makeSendReady(ses, tenantName);
  return { environmentId: row.id, token, ses, tenantName };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    from: "Acme <hello@acme.test>",
    to: ["person@example.test"],
    subject: "Your weekly digest",
    html: "<p>Hello</p>",
    ...overrides,
  };
}

function sendRequest(options: {
  token?: string;
  idempotencyKey?: string;
  body?: unknown;
  contentLength?: string;
}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "idempotency-key": options.idempotencyKey ?? "idem-default",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.contentLength) headers["content-length"] = options.contentLength;
  return new Request("http://localhost:3004/api/email/send", {
    method: "POST",
    headers,
    body: JSON.stringify(options.body ?? { message: message() }),
  });
}

function batchRequest(options: {
  token?: string;
  body?: unknown;
  contentLength?: string;
}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.contentLength) headers["content-length"] = options.contentLength;
  return new Request("http://localhost:3004/api/email/send-batch", {
    method: "POST",
    headers,
    body: JSON.stringify(options.body ?? {}),
  });
}

/** How many times the wire was actually touched. The only honest counter. */
function sendCalls(ses: FakeSesClient): number {
  return ses.calls.filter((call) => call.method === "sendEmail").length;
}

function batchCalls(ses: FakeSesClient): number {
  return ses.calls.filter((call) => call.method === "sendBatch").length;
}

async function results(response: Response): Promise<RelayBatchResult[]> {
  return ((await response.json()) as { results: RelayBatchResult[] }).results;
}

function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

/**
 * A base64 string whose DECODED length is exactly `decodedBytes` (which must
 * be divisible by 3, so no padding muddies the arithmetic). Built directly as
 * base64 — `"AAAA"` decodes to three NUL bytes — so a 26 MB fixture costs one
 * string repeat, not a Buffer round trip.
 */
function bigBase64(decodedBytes: number): string {
  if (decodedBytes % 3 !== 0) throw new Error("pick a multiple of 3");
  return "AAAA".repeat(decodedBytes / 3);
}

async function cleanup(): Promise<void> {
  await db.delete(organizations).where(inArray(organizations.id, [ORG]));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db.insert(organizations).values({
    id: ORG,
    name: "Email Relay Attachments Test Org",
    region: "us",
  });
});

afterAll(async () => {
  await cleanup();
  resetSesClients();
  await sqlClient.end();
});

describe("POST /api/email/send — no attachments is unchanged", () => {
  it("crosses the seam with NO attachments key at all", async () => {
    const fixture = await seed();

    const response = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "plain-send" }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "fake-ses-message-1" });

    const call = fixture.ses.calls.find((c) => c.method === "sendEmail");
    const input = call?.args[0] as SesSendEmailInput;
    // The WHOLE input, exactly today's shape — this is what proves the change
    // is not a regression for every existing send.
    expect(input).toEqual({
      tenantName: fixture.tenantName,
      configurationSetName: sesConfigurationSetName(fixture.environmentId),
      message: {
        from: "Acme <hello@acme.test>",
        to: ["person@example.test"],
        subject: "Your weekly digest",
        html: "<p>Hello</p>",
      },
    });
    // `toEqual` ignores keys holding `undefined`, so say it explicitly: the
    // key is ABSENT, not present-and-empty.
    expect(input.message).not.toHaveProperty("attachments");
  });

  it("treats an explicitly empty attachments array as none", async () => {
    const fixture = await seed();

    const response = await handleRelaySend(
      sendRequest({
        token: fixture.token,
        idempotencyKey: "empty-array",
        body: { message: message({ attachments: [] }) },
      }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(200);
    const call = fixture.ses.calls.find((c) => c.method === "sendEmail");
    const input = call?.args[0] as SesSendEmailInput;
    expect(input.message).not.toHaveProperty("attachments");
  });
});

describe("POST /api/email/send — attachments reach the seam", () => {
  it("carries the files as { base64 } with the right decoded bytes", async () => {
    const fixture = await seed();
    const invoiceBytes = Buffer.from("%PDF-1.4 fake invoice body", "utf-8");
    const logoBytes = Buffer.from("PNGDATA", "utf-8");

    const response = await handleRelaySend(
      sendRequest({
        token: fixture.token,
        idempotencyKey: "with-files",
        body: {
          message: message({
            attachments: [
              {
                filename: "invoice.pdf",
                content: invoiceBytes.toString("base64"),
                contentType: "application/pdf",
              },
              {
                filename: "logo.png",
                content: logoBytes.toString("base64"),
                contentType: "image/png",
                disposition: "inline",
                contentId: "logo",
              },
            ],
          }),
        },
      }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(200);
    const [sent] = fixture.ses.__sent();
    expect(sent?.message.attachments).toEqual([
      {
        filename: "invoice.pdf",
        content: { base64: invoiceBytes.toString("base64") },
        contentType: "application/pdf",
      },
      {
        filename: "logo.png",
        content: { base64: logoBytes.toString("base64") },
        contentType: "image/png",
        disposition: "inline",
        contentId: "logo",
      },
    ]);

    // The recorded base64 genuinely decodes back to the caller's bytes — the
    // whole point of the always-base64 wire.
    const recorded = sent?.message.attachments?.[0]?.content;
    if (!recorded || recorded instanceof Uint8Array) {
      throw new Error("expected the { base64 } wrapper on the seam");
    }
    expect(Buffer.from(recorded.base64, "base64").equals(invoiceBytes)).toBe(
      true,
    );
  });

  it("delivers a BINARY file byte-for-byte, end to end", async () => {
    // The customer-facing claim, asserted where a customer's file actually
    // enters: JSON over HTTP → validation → the seam → what SES composes.
    // Every fixture above this one is ASCII, and ASCII survives a 7-bit
    // pipeline untouched — which is exactly why this suite stayed green while
    // real SES replaced every byte above 127 with U+FFFD (2026-08-12). This
    // payload carries all 256 byte values, so it cannot pass by accident.
    const fixture = await seed();

    const response = await handleRelaySend(
      sendRequest({
        token: fixture.token,
        idempotencyKey: "binary-file",
        body: {
          message: message({
            attachments: [
              {
                filename: "scan.pdf",
                content: BINARY_FIXTURE_BASE64,
                contentType: "application/pdf",
              },
            ],
          }),
        },
      }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(200);
    const delivered = fixture.ses.__sent()[0]?.delivered?.[0];
    expect(delivered?.transferEncoding).toBe("BASE64");
    expect(Array.from(delivered?.content ?? [])).toEqual(
      Array.from(BINARY_FIXTURE),
    );
    expect(countNonAscii(delivered?.content ?? new Uint8Array())).toBe(
      BINARY_FIXTURE_NON_ASCII,
    );
  });
});

describe("POST /api/email/send — the size gate refuses before the wire", () => {
  it("refuses an over-total send naming limit AND actual, SES untouched", async () => {
    const fixture = await seed();
    // Two files, each comfortably under the cap ALONE — the refusal below is
    // therefore a fact about the TOTAL, on decoded bytes: 2 × 13,107,201 =
    // 26,214,402, two bytes over the 26,214,400 limit.
    const half = bigBase64(13_107_201);

    const response = await handleRelaySend(
      sendRequest({
        token: fixture.token,
        idempotencyKey: "over-total",
        body: {
          message: message({
            attachments: [
              { filename: "part-1.bin", content: half },
              { filename: "part-2.bin", content: half },
            ],
          }),
        },
      }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_attachment");
    expect(body.message).toContain(String(MAX_ATTACHMENT_BYTES)); // the limit
    expect(body.message).toContain("26214402"); // the actual
    // Refusing after calling SES would be worthless. The wire was never touched.
    expect(sendCalls(fixture.ses)).toBe(0);
  }, 60_000);

  it("refuses too many attachments", async () => {
    const fixture = await seed();
    const attachments = Array.from(
      { length: MAX_ATTACHMENT_COUNT + 1 },
      (_, i) => ({ filename: `file-${i}.txt`, content: b64("hi") }),
    );

    const response = await handleRelaySend(
      sendRequest({
        token: fixture.token,
        idempotencyKey: "too-many",
        body: { message: message({ attachments }) },
      }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_attachment");
    expect(body.message).toBe(
      `Too many attachments: ${MAX_ATTACHMENT_COUNT + 1} (limit ${MAX_ATTACHMENT_COUNT})`,
    );
    expect(sendCalls(fixture.ses)).toBe(0);
  });

  it("refuses a CR/LF filename", async () => {
    const fixture = await seed();

    const response = await handleRelaySend(
      sendRequest({
        token: fixture.token,
        idempotencyKey: "crlf-name",
        body: {
          message: message({
            attachments: [
              {
                filename: "evil\r\nX-Injected: header.pdf",
                content: b64("payload"),
              },
            ],
          }),
        },
      }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_attachment");
    expect(body.message).toContain("CR, LF or NUL");
    expect(sendCalls(fixture.ses)).toBe(0);
  });

  it("refuses content that is not base64, naming the file", async () => {
    const fixture = await seed();

    const response = await handleRelaySend(
      sendRequest({
        token: fixture.token,
        idempotencyKey: "not-base64",
        body: {
          message: message({
            attachments: [
              {
                filename: "notes.txt",
                content: "this is definitely not base64!!!",
              },
            ],
          }),
        },
      }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_attachment");
    expect(body.message).toContain("notes.txt");
    expect(body.message).toContain("base64");
    expect(sendCalls(fixture.ses)).toBe(0);
  });

  it("refuses an over-long contentType rather than letting SES 400", async () => {
    const fixture = await seed();

    const response = await handleRelaySend(
      sendRequest({
        token: fixture.token,
        idempotencyKey: "long-content-type",
        body: {
          message: message({
            attachments: [
              {
                filename: "report.bin",
                content: b64("data"),
                contentType: `application/x-${"y".repeat(79)}`,
              },
            ],
          }),
        },
      }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_attachment");
    expect(body.message).toContain("(limit 78)");
    expect(sendCalls(fixture.ses)).toBe(0);
  });
});

describe("POST /api/email/send-batch — the cap is PER MESSAGE", () => {
  it("carries attachments through the batch wire", async () => {
    const fixture = await seed();

    const response = await handleRelaySendBatch(
      batchRequest({
        token: fixture.token,
        body: {
          items: [
            {
              idempotencyKey: "batch-file-1",
              message: message({
                to: ["one@example.test"],
                attachments: [
                  { filename: "one.txt", content: b64("first file") },
                ],
              }),
            },
            {
              idempotencyKey: "batch-file-2",
              message: message({
                to: ["two@example.test"],
                attachments: [
                  { filename: "two.txt", content: b64("second file") },
                ],
              }),
            },
          ],
        },
      }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(200);
    const entries = await results(response);
    expect(entries.map((entry) => entry.status)).toEqual(["sent", "sent"]);

    const call = fixture.ses.calls.find((c) => c.method === "sendBatch");
    const input = call?.args[0] as SesSendBatchInput;
    expect(input.messages[0]?.attachments).toEqual([
      { filename: "one.txt", content: { base64: b64("first file") } },
    ]);
    expect(input.messages[1]?.attachments).toEqual([
      { filename: "two.txt", content: { base64: b64("second file") } },
    ]);
  });

  it("allows a batch whose items SUM over the cap while each is under it", async () => {
    const fixture = await seed();
    // 15 MiB decoded per item; 30 MiB across the batch — over the per-message
    // cap only if the cap were per BATCH. It is not: SES's own 40 MB limit is
    // per message, and this send succeeding is the assertion of that decision.
    const fifteenMiB = bigBase64(15 * 1024 * 1024);

    const response = await handleRelaySendBatch(
      batchRequest({
        token: fixture.token,
        body: {
          items: [
            {
              idempotencyKey: "per-message-1",
              message: message({
                to: ["heavy-one@example.test"],
                attachments: [{ filename: "a.bin", content: fifteenMiB }],
              }),
            },
            {
              idempotencyKey: "per-message-2",
              message: message({
                to: ["heavy-two@example.test"],
                attachments: [{ filename: "b.bin", content: fifteenMiB }],
              }),
            },
          ],
        },
      }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(200);
    const entries = await results(response);
    expect(entries.map((entry) => entry.status)).toEqual(["sent", "sent"]);
    expect(batchCalls(fixture.ses)).toBe(1);
  }, 60_000);

  it("refuses the whole batch when ONE item is over, naming the item", async () => {
    const fixture = await seed();

    const response = await handleRelaySendBatch(
      batchRequest({
        token: fixture.token,
        body: {
          items: [
            {
              idempotencyKey: "fine-item",
              message: message({
                to: ["fine@example.test"],
                attachments: [{ filename: "small.txt", content: b64("ok") }],
              }),
            },
            {
              idempotencyKey: "oversize-item",
              message: message({
                to: ["oversize@example.test"],
                attachments: [
                  { filename: "huge.bin", content: bigBase64(26_214_402) },
                ],
              }),
            },
          ],
        },
      }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_attachment");
    expect(body.message).toContain("items[1]:");
    expect(body.message).toContain(String(MAX_ATTACHMENT_BYTES));
    expect(body.message).toContain("26214402");
    // NOTHING went to the wire — not even the fine item. Validation is whole-
    // request, before any claim or send.
    expect(batchCalls(fixture.ses)).toBe(0);
    expect(sendCalls(fixture.ses)).toBe(0);
  }, 60_000);
});

describe("the body cap refuses an oversize request BEFORE parsing", () => {
  it("send: refuses on the declared length without reading a byte", async () => {
    const fixture = await seed();

    const response = await handleRelaySend(
      sendRequest({
        token: fixture.token,
        idempotencyKey: "declared-oversize",
        contentLength: String(MAX_SEND_REQUEST_BYTES + 1),
      }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("payload_too_large");
    expect(body.message).toContain(String(MAX_SEND_REQUEST_BYTES));
    expect(sendCalls(fixture.ses)).toBe(0);
  });

  it("send: refuses a genuinely oversize body on the metered stream", async () => {
    const fixture = await seed();
    // Real bytes, over the cap: base64 whose ENCODED length alone exceeds the
    // request cap. `readJson` counts the stream and cancels — this 413 happens
    // before JSON.parse ever sees the body, which is the whole point: a cap
    // that decodes first is a memory bill, not a cap.
    const response = await handleRelaySend(
      sendRequest({
        token: fixture.token,
        idempotencyKey: "streamed-oversize",
        body: {
          message: message({
            attachments: [
              {
                filename: "way-too-big.bin",
                content: bigBase64(31_457_280), // 30 MiB raw → ~41.9M chars encoded
              },
            ],
          }),
        },
      }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: "payload_too_large",
    });
    expect(sendCalls(fixture.ses)).toBe(0);
  }, 60_000);

  it("batch: holds its own, larger cap", async () => {
    const fixture = await seed();
    // 50 MiB declared: over the send cap, under the batch cap. The same
    // declared length refused above is accepted here — the two endpoints'
    // caps are genuinely different numbers, not one constant spelled twice.
    const declared = String(50 * 1024 * 1024);

    const accepted = await handleRelaySendBatch(
      batchRequest({
        token: fixture.token,
        contentLength: declared,
        body: {
          items: [{ idempotencyKey: "under-batch-cap", message: message() }],
        },
      }),
      { ses: fixture.ses },
    );
    expect(accepted.status).toBe(200);

    const refused = await handleRelaySendBatch(
      batchRequest({
        token: fixture.token,
        contentLength: String(MAX_BATCH_REQUEST_BYTES + 1),
        body: {
          items: [{ idempotencyKey: "over-batch-cap", message: message() }],
        },
      }),
      { ses: fixture.ses },
    );
    expect(refused.status).toBe(413);
    const body = (await refused.json()) as { error: string; message: string };
    expect(body.error).toBe("payload_too_large");
    expect(body.message).toContain(String(MAX_BATCH_REQUEST_BYTES));
    // Exactly ONE batch reached the wire: the accepted one.
    expect(batchCalls(fixture.ses)).toBe(1);
  });
});
