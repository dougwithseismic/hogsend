import { EmailSendError } from "@hogsend/email";
import { createElement } from "react";
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

function dummyElement() {
  return createElement("div", null, "test");
}

describe("sendEmail", () => {
  it("sends successfully and returns id", async () => {
    const client = mockResendClient();
    const result = await sendEmail({
      client,
      options: {
        from: "test@hogsend.com",
        to: "user@example.com",
        subject: "Test",
        react: dummyElement(),
      },
    });
    expect(result.id).toBe("resend_123");
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
        react: dummyElement(),
      },
    });

    expect(sendFn).toHaveBeenCalledWith(
      expect.objectContaining({ to: ["user@example.com"] }),
    );
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
          react: dummyElement(),
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
        react: dummyElement(),
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
          react: dummyElement(),
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
          react: dummyElement(),
        },
        {
          from: "a@hogsend.com",
          to: "c@example.com",
          subject: "B",
          react: dummyElement(),
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
      react: dummyElement(),
    }));

    await sendBatchEmails({ client, emails });

    expect(batchFn).toHaveBeenCalledTimes(2);
    const firstCallArgs = batchFn.mock.calls[0]?.[0] as unknown[];
    const secondCallArgs = batchFn.mock.calls[1]?.[0] as unknown[];
    expect(firstCallArgs).toHaveLength(100);
    expect(secondCallArgs).toHaveLength(50);
  });
});
