import { EmailSendError } from "@hogsend/email";
import type { Resend } from "resend";
import { describe, expect, it, vi } from "vitest";
import { createResendProvider } from "../provider.js";
import { sendBatchEmails, sendEmail } from "../send.js";

function mockResendClient(overrides?: {
  sendFn?: () => Promise<unknown>;
  batchFn?: () => Promise<unknown>;
}) {
  return {
    emails: {
      send:
        overrides?.sendFn ??
        vi.fn().mockResolvedValue({
          data: { id: "resend_123" },
          error: null,
        }),
    },
    batch: {
      send:
        overrides?.batchFn ??
        vi.fn().mockResolvedValue({
          data: { data: [{ id: "batch_1" }, { id: "batch_2" }] },
          error: null,
        }),
    },
  } as unknown as Resend;
}

const HTML = "<p>test</p>";

describe("sendEmail", () => {
  it("sends successfully and returns id", async () => {
    const client = mockResendClient();
    const result = await sendEmail({
      client,
      options: {
        from: "test@hogsend.com",
        to: "user@example.com",
        subject: "Test",
        html: HTML,
      },
    });
    expect(result.id).toBe("resend_123");
  });

  it("sends HTML on the wire (never React)", async () => {
    const sendFn = vi.fn().mockResolvedValue({
      data: { id: "resend_123" },
      error: null,
    });
    const client = mockResendClient({ sendFn });

    await sendEmail({
      client,
      options: {
        from: "test@hogsend.com",
        to: "user@example.com",
        subject: "Test",
        html: HTML,
        text: "test",
      },
    });

    const arg = sendFn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.html).toBe(HTML);
    expect(arg.text).toBe("test");
    expect(arg).not.toHaveProperty("react");
  });

  it("normalizes string recipient to array", async () => {
    const sendFn = vi.fn().mockResolvedValue({
      data: { id: "resend_123" },
      error: null,
    });
    const client = mockResendClient({ sendFn });

    await sendEmail({
      client,
      options: {
        from: "test@hogsend.com",
        to: "user@example.com",
        subject: "Test",
        html: HTML,
      },
    });

    expect(sendFn).toHaveBeenCalledWith(
      expect.objectContaining({ to: ["user@example.com"] }),
    );
  });

  it("passes neutral tags straight through to Resend", async () => {
    const sendFn = vi.fn().mockResolvedValue({
      data: { id: "resend_123" },
      error: null,
    });
    const client = mockResendClient({ sendFn });

    const tags = [
      { name: "campaign", value: "q1" },
      { name: "cohort", value: "beta" },
    ];
    await sendEmail({
      client,
      options: {
        from: "test@hogsend.com",
        to: "user@example.com",
        subject: "Test",
        html: HTML,
        tags,
      },
    });

    const arg = sendFn.mock.calls[0]?.[0] as {
      tags?: Array<{ name: string; value: string }>;
    };
    expect(arg.tags).toEqual(tags);
  });

  it("sanitizes tag names/values to Resend's allowed charset", async () => {
    const sendFn = vi.fn().mockResolvedValue({
      data: { id: "resend_123" },
      error: null,
    });
    const client = mockResendClient({ sendFn });

    await sendEmail({
      client,
      options: {
        from: "test@hogsend.com",
        to: "user@example.com",
        subject: "Test",
        html: HTML,
        // The engine's neutral tags carry journey names and slashed template
        // keys — Resend only allows [A-Za-z0-9_-].
        tags: [
          { name: "journeyId", value: "Docs Subscriber" },
          { name: "templateKey", value: "docs/welcome" },
        ],
      },
    });

    const arg = sendFn.mock.calls[0]?.[0] as {
      tags?: Array<{ name: string; value: string }>;
    };
    expect(arg.tags).toEqual([
      { name: "journeyId", value: "Docs-Subscriber" },
      { name: "templateKey", value: "docs-welcome" },
    ]);
  });

  it("omits Resend tags when none are set", async () => {
    const sendFn = vi.fn().mockResolvedValue({
      data: { id: "resend_123" },
      error: null,
    });
    const client = mockResendClient({ sendFn });

    await sendEmail({
      client,
      options: {
        from: "test@hogsend.com",
        to: "user@example.com",
        subject: "Test",
        html: HTML,
      },
    });

    const arg = sendFn.mock.calls[0]?.[0] as { tags?: unknown };
    expect(arg.tags).toBeUndefined();
  });

  it("throws EmailSendError on API error", async () => {
    const client = mockResendClient({
      sendFn: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "Invalid API key" },
      }),
    });

    await expect(
      sendEmail({
        client,
        options: {
          from: "test@hogsend.com",
          to: "user@example.com",
          subject: "Test",
          html: HTML,
        },
        retryOptions: { maxRetries: 0 },
      }),
    ).rejects.toThrow(EmailSendError);
  });

  it("retries on transient errors", async () => {
    let attempt = 0;
    const sendFn = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt < 3) {
        return {
          data: null,
          error: { message: "rate limit exceeded", statusCode: 429 },
        };
      }
      return { data: { id: "resend_success" }, error: null };
    });
    const client = mockResendClient({ sendFn });

    const result = await sendEmail({
      client,
      options: {
        from: "test@hogsend.com",
        to: "user@example.com",
        subject: "Test",
        html: HTML,
      },
      retryOptions: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50 },
    });

    expect(result.id).toBe("resend_success");
    expect(sendFn).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable errors", async () => {
    const sendFn = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "Invalid email address", statusCode: 422 },
    });
    const client = mockResendClient({ sendFn });

    await expect(
      sendEmail({
        client,
        options: {
          from: "test@hogsend.com",
          to: "user@example.com",
          subject: "Test",
          html: HTML,
        },
        retryOptions: { maxRetries: 3, baseDelayMs: 10 },
      }),
    ).rejects.toThrow(EmailSendError);

    expect(sendFn).toHaveBeenCalledTimes(1);
  });
});

describe("attachments", () => {
  const okSend = () =>
    vi.fn().mockResolvedValue({ data: { id: "resend_123" }, error: null });
  const base = {
    from: "test@hogsend.com",
    to: "user@example.com",
    subject: "Test",
    html: HTML,
  };

  it("puts NO attachments key on the wire when none are given", async () => {
    const sendFn = okSend();
    await sendEmail({ client: mockResendClient({ sendFn }), options: base });
    // True key absence, not just an undefined value — this is what proves the
    // no-attachment send is byte-identical to before.
    expect(sendFn.mock.calls[0]?.[0]).not.toHaveProperty("attachments");
  });

  it("puts NO attachments key on the wire for an empty array", async () => {
    const sendFn = okSend();
    await sendEmail({
      client: mockResendClient({ sendFn }),
      options: { ...base, attachments: [] },
    });
    expect(sendFn.mock.calls[0]?.[0]).not.toHaveProperty("attachments");
  });

  it("maps Uint8Array content to a Buffer of the same bytes", async () => {
    const sendFn = okSend();
    const bytes = new TextEncoder().encode("hello world");
    await sendEmail({
      client: mockResendClient({ sendFn }),
      options: {
        ...base,
        attachments: [{ filename: "invoice.pdf", content: bytes }],
      },
    });
    const arg = sendFn.mock.calls[0]?.[0] as {
      attachments: Array<Record<string, unknown>>;
    };
    const att = arg.attachments[0] as { filename: string; content: Buffer };
    expect(att.filename).toBe("invoice.pdf");
    expect(Buffer.isBuffer(att.content)).toBe(true);
    expect(att.content.equals(Buffer.from("hello world"))).toBe(true);
  });

  it("passes { base64 } content through untouched (no decode/re-encode)", async () => {
    const sendFn = okSend();
    // UNPADDED on purpose: a decode/re-encode round trip would re-pad it to
    // "aGVsbG8=", so string equality proves the content was never touched.
    const unpadded = "aGVsbG8";
    await sendEmail({
      client: mockResendClient({ sendFn }),
      options: {
        ...base,
        attachments: [{ filename: "hello.txt", content: { base64: unpadded } }],
      },
    });
    const arg = sendFn.mock.calls[0]?.[0] as {
      attachments: Array<{ content: unknown }>;
    };
    expect(arg.attachments[0]?.content).toBe(unpadded);
  });

  it("maps contentType, omits it when absent, and NEVER sets path", async () => {
    const sendFn = okSend();
    await sendEmail({
      client: mockResendClient({ sendFn }),
      options: {
        ...base,
        attachments: [
          {
            filename: "invoice.pdf",
            content: { base64: "aGVsbG8=" },
            contentType: "application/pdf",
          },
          { filename: "raw.bin", content: { base64: "aGVsbG8=" } },
        ],
      },
    });
    const arg = sendFn.mock.calls[0]?.[0] as {
      attachments: Array<Record<string, unknown>>;
    };
    expect(arg.attachments[0]?.contentType).toBe("application/pdf");
    expect(arg.attachments[1]).not.toHaveProperty("contentType");
    // `path` makes Resend FETCH a URL — an SSRF-shaped surprise the neutral
    // contract never means. It must not exist on any mapped attachment.
    for (const att of arg.attachments) {
      expect(att).not.toHaveProperty("path");
    }
  });

  it("maps an inline attachment's contentId (bare id — the HTML adds cid:)", async () => {
    const sendFn = okSend();
    await sendEmail({
      client: mockResendClient({ sendFn }),
      options: {
        ...base,
        attachments: [
          {
            filename: "logo.png",
            content: { base64: "aGVsbG8=" },
            disposition: "inline",
            contentId: "logo",
          },
        ],
      },
    });
    const arg = sendFn.mock.calls[0]?.[0] as {
      attachments: Array<{ contentId?: string }>;
    };
    // Resend's send-side type has no disposition field — contentId presence IS
    // the inline marker, and its value is the bare id the HTML cid:-references.
    expect(arg.attachments[0]?.contentId).toBe("logo");
  });

  it("degrades inline-without-contentId to a regular attachment", async () => {
    const sendFn = okSend();
    await sendEmail({
      client: mockResendClient({ sendFn }),
      options: {
        ...base,
        attachments: [
          {
            filename: "banner.png",
            content: { base64: "aGVsbG8=" },
            disposition: "inline",
            // no contentId — unrepresentable as inline on Resend's wire
          },
        ],
      },
    });
    const arg = sendFn.mock.calls[0]?.[0] as {
      attachments: Array<Record<string, unknown>>;
    };
    // The decision (see toResendAttachments): the file still rides as a plain
    // attachment. Nothing in the HTML can reference it without a contentId, so
    // only a presentation hint is lost — never content.
    expect(arg.attachments).toHaveLength(1);
    expect(arg.attachments[0]?.filename).toBe("banner.png");
    expect(arg.attachments[0]).not.toHaveProperty("contentId");
    expect(arg.attachments[0]).not.toHaveProperty("path");
  });

  it("declares capabilities.attachments", () => {
    const provider = createResendProvider({ apiKey: "re_test" });
    expect(provider.capabilities?.attachments).toBe(true);
  });
});

describe("sendBatchEmails", () => {
  it("returns empty array for empty input", async () => {
    const client = mockResendClient();
    const result = await sendBatchEmails({ client, emails: [] });
    expect(result).toEqual([]);
  });

  it("sends a batch and returns ids", async () => {
    const client = mockResendClient();
    const result = await sendBatchEmails({
      client,
      emails: [
        {
          from: "a@hogsend.com",
          to: "b@example.com",
          subject: "A",
          html: HTML,
        },
        {
          from: "a@hogsend.com",
          to: "c@example.com",
          subject: "B",
          html: HTML,
        },
      ],
    });
    expect(result).toEqual([{ id: "batch_1" }, { id: "batch_2" }]);
  });

  it("auto-chunks lists larger than 100", async () => {
    const batchFn = vi.fn().mockResolvedValue({
      data: { data: Array.from({ length: 50 }, (_, i) => ({ id: `id_${i}` })) },
      error: null,
    });
    const client = mockResendClient({ batchFn });

    const emails = Array.from({ length: 150 }, (_, i) => ({
      from: "a@hogsend.com",
      to: `user${i}@example.com`,
      subject: `Email ${i}`,
      html: HTML,
    }));

    await sendBatchEmails({ client, emails });

    expect(batchFn).toHaveBeenCalledTimes(2);
    const firstCallArgs = batchFn.mock.calls[0]?.[0] as unknown[];
    const secondCallArgs = batchFn.mock.calls[1]?.[0] as unknown[];
    expect(firstCallArgs).toHaveLength(100);
    expect(secondCallArgs).toHaveLength(50);
  });

  it("keeps the batch wire attachment-free for no-attachment batches", async () => {
    const batchFn = vi.fn().mockResolvedValue({
      data: { data: [{ id: "batch_1" }] },
      error: null,
    });
    const client = mockResendClient({ batchFn });
    await sendBatchEmails({
      client,
      emails: [
        {
          from: "a@hogsend.com",
          to: "b@example.com",
          subject: "A",
          html: HTML,
        },
      ],
    });
    const items = batchFn.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    // Resend's batch API rejects the field outright (CreateBatchEmailOptions
    // omits it) — the mapped items must never grow one.
    expect(items[0]).not.toHaveProperty("attachments");
  });

  it("falls back to per-item single sends when any item carries attachments", async () => {
    // Resend's batch API cannot carry attachments, so a batch containing ANY
    // must route every item through emails.send — files riding each item,
    // results in input order, batch.send never called.
    let n = 0;
    const sendFn = vi.fn().mockImplementation(async () => ({
      data: { id: `single_${++n}` },
      error: null,
    }));
    const batchFn = vi.fn();
    const client = mockResendClient({ sendFn, batchFn });

    const results = await sendBatchEmails({
      client,
      emails: [
        {
          from: "a@hogsend.com",
          to: "b@example.com",
          subject: "A",
          html: HTML,
        },
        {
          from: "a@hogsend.com",
          to: "c@example.com",
          subject: "B",
          html: HTML,
          attachments: [
            { filename: "invoice.pdf", content: { base64: "aGVsbG8" } },
          ],
        },
      ],
    });

    expect(batchFn).not.toHaveBeenCalled();
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(results).toEqual([{ id: "single_1" }, { id: "single_2" }]);
    // The attachment rides its item on the single-send wire, untouched.
    const first = sendFn.mock.calls[0]?.[0] as Record<string, unknown>;
    const second = sendFn.mock.calls[1]?.[0] as {
      attachments: Array<{ filename: string; content: unknown }>;
    };
    expect(first).not.toHaveProperty("attachments");
    expect(second.attachments[0]?.filename).toBe("invoice.pdf");
    expect(second.attachments[0]?.content).toBe("aGVsbG8");
  });
});
