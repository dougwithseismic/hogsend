import { describe, expect, it } from "vitest";
import {
  EmailSendError,
  EmailSuppressionError,
  WebhookVerificationError,
} from "../types.js";

describe("EmailSendError", () => {
  it("has retryable flag", () => {
    const err = new EmailSendError("rate limited", {
      retryable: true,
      statusCode: 429,
    });
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(429);
    expect(err.name).toBe("EmailSendError");
    expect(err.message).toBe("rate limited");
  });

  it("supports non-retryable errors", () => {
    const err = new EmailSendError("bad address", {
      retryable: false,
      statusCode: 422,
    });
    expect(err.retryable).toBe(false);
  });

  it("preserves cause", () => {
    const cause = new Error("original");
    const err = new EmailSendError("wrapped", {
      retryable: false,
      cause,
    });
    expect(err.cause).toBe(cause);
  });
});

describe("EmailSuppressionError", () => {
  it("formats message with reason and email", () => {
    const err = new EmailSuppressionError("unsubscribed", "user@example.com");
    expect(err.message).toContain("unsubscribed");
    expect(err.message).toContain("user@example.com");
    expect(err.reason).toBe("unsubscribed");
    expect(err.name).toBe("EmailSuppressionError");
  });
});

describe("WebhookVerificationError", () => {
  it("sets name and message", () => {
    const err = new WebhookVerificationError("bad sig");
    expect(err.name).toBe("WebhookVerificationError");
    expect(err.message).toBe("bad sig");
  });
});
