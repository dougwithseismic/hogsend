import { EmailSendError } from "@hogsend/email";
import type { Resend } from "resend";
import { describe, expect, it, vi } from "vitest";
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
});
