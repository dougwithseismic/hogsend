import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  BatchEmailItem,
  EmailAttachment,
  EmailEvent,
  EmailEventType,
  EmailProviderCapabilities,
  SendEmailOptions,
  WebhookHandlerMap,
} from "./email.js";
import {
  ATTACHMENT_CONTENT_ID_MAX,
  ATTACHMENT_CONTENT_TYPE_MAX,
  ATTACHMENT_FILENAME_MAX,
  assertValidAttachments,
  attachmentByteLength,
  InvalidAttachmentError,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
} from "./email.js";

/**
 * The provider-neutral email event contract (PRD 18).
 *
 * These are TYPE assertions, so their failing signal is `check-types` rather
 * than the runtime run — `EmailEventType` has no runtime footprint to assert
 * against. That is the honest place for it: the whole point of the union is
 * that a provider emitting a type the engine has no branch for cannot compile.
 */

describe("EmailEventType", () => {
  it("pins the union, INCLUDING the non-suppressing `email.rejected`", () => {
    // `email.rejected` is SES's `Reject`: the message was accepted, a message
    // id was returned, and then SES threw it away (virus). It is OUR fault, not
    // the recipient's — which is exactly why it may not be folded onto
    // `email.bounced`, whose `permanent` class auto-suppresses. One bad
    // attachment would otherwise permanently block a deliverable address.
    expectTypeOf<EmailEventType>().toEqualTypeOf<
      | "email.sent"
      | "email.delivered"
      | "email.bounced"
      | "email.complained"
      | "email.delivery_delayed"
      | "email.opened"
      | "email.clicked"
      | "email.rejected"
    >();
  });

  it("gives every type a handler slot on the handler map", () => {
    // Additive by construction: a consumer that wants to hear about rejects
    // gets a `WebhookHandlerMap` key for free.
    expectTypeOf<WebhookHandlerMap>().toHaveProperty("email.rejected");
  });
});

describe("EmailEvent", () => {
  it("carries the reject reason in its OWN field, never in `bounce`", () => {
    // Verbatim, and structurally separate. Putting SES's reason on `bounce`
    // would put a reject one `class` assignment away from suppressing the
    // recipient, which is the failure this type exists to make impossible.
    expectTypeOf<EmailEvent["reject"]>().toEqualTypeOf<
      { reason: string } | undefined
    >();
  });
});

/**
 * The neutral attachment contract (PRD 17). Type pins for the shapes six
 * packages will translate, plus runtime assertions for the ONE shared
 * validator — the relay 400s with it and the engine mailer throws with it, so
 * its answers here ARE the contract.
 */

function att(overrides: Partial<EmailAttachment> = {}): EmailAttachment {
  return {
    filename: "invoice.pdf",
    content: new Uint8Array([1, 2, 3]),
    ...overrides,
  };
}

describe("EmailAttachment contract", () => {
  it("pins the bytes-vs-base64 content discriminant", () => {
    // A bare base64 STRING must not be assignable: the AWS SDK base64-encodes
    // raw content itself, so a bare string mistaken for raw bytes would be
    // encoded twice and send a corrupt-but-delivered file. The `{ base64 }`
    // wrapper is the caller's declaration.
    expectTypeOf<EmailAttachment["content"]>().toEqualTypeOf<
      Uint8Array | { base64: string }
    >();
    expectTypeOf<EmailAttachment["filename"]>().toEqualTypeOf<string>();
    expectTypeOf<EmailAttachment["contentType"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<EmailAttachment["disposition"]>().toEqualTypeOf<
      "attachment" | "inline" | undefined
    >();
    expectTypeOf<EmailAttachment["contentId"]>().toEqualTypeOf<
      string | undefined
    >();
  });

  it("rides the send wire AND is inherited by BatchEmailItem", () => {
    // BatchEmailItem = Omit<SendEmailOptions, "scheduledAt">, so attachments
    // flow through sendBatch with no batch-specific shape to drift.
    expectTypeOf<SendEmailOptions["attachments"]>().toEqualTypeOf<
      EmailAttachment[] | undefined
    >();
    expectTypeOf<BatchEmailItem["attachments"]>().toEqualTypeOf<
      EmailAttachment[] | undefined
    >();
  });

  it("has a capability flag whose ABSENCE means cannot-carry", () => {
    expectTypeOf<EmailProviderCapabilities["attachments"]>().toEqualTypeOf<
      boolean | undefined
    >();
  });
});

describe("attachmentByteLength", () => {
  it("agrees between Uint8Array and the equivalent { base64 }", () => {
    // THE assertion protecting the size cap: a base64 string is 4/3 the size
    // of what it represents, so counting the encoded length would make the
    // cap a third too permissive. Known RFC 4648 vectors, each padding case:
    //   "Man" → "TWFu" (no pad), "Ma" → "TWE=" (one =), "M" → "TQ==" (two =).
    const cases: Array<[number[], string]> = [
      [[77, 97, 110], "TWFu"],
      [[77, 97], "TWE="],
      [[77], "TQ=="],
    ];
    for (const [bytes, base64] of cases) {
      const fromBytes = attachmentByteLength(
        att({ content: new Uint8Array(bytes) }),
      );
      const fromBase64 = attachmentByteLength(att({ content: { base64 } }));
      expect(fromBase64).toBe(fromBytes);
      expect(fromBase64).toBe(bytes.length);
    }
  });

  it("agrees on a generated 1000-byte payload (needs `=` padding)", () => {
    // 1000 % 3 !== 0, so the encoding ends in "==". Encoded length is 1336;
    // the decoded answer must be 1000, not 1336.
    const bytes = new Uint8Array(1000).fill(7);
    const base64 = Buffer.from(bytes).toString("base64");
    expect(base64.endsWith("==")).toBe(true);
    expect(attachmentByteLength(att({ content: bytes }))).toBe(1000);
    expect(attachmentByteLength(att({ content: { base64 } }))).toBe(1000);
  });

  it("ignores MIME-style line wrapping — whitespace is not content", () => {
    const base64 = Buffer.from(new Uint8Array(120).fill(1)).toString("base64");
    const wrapped = base64.replace(/(.{76})/g, "$1\r\n");
    expect(attachmentByteLength(att({ content: { base64: wrapped } }))).toBe(
      120,
    );
  });

  it("handles unpadded base64", () => {
    // "TWE" is the unpadded encoding of "Ma" (2 bytes).
    expect(attachmentByteLength(att({ content: { base64: "TWE" } }))).toBe(2);
  });
});

describe("assertValidAttachments", () => {
  it("passes a valid set (raw bytes, base64, and an inline image)", () => {
    expect(() =>
      assertValidAttachments([
        att({ contentType: "application/pdf" }),
        att({ filename: "report.csv", content: { base64: "TWFu" } }),
        att({
          filename: "logo.png",
          contentType: "image/png",
          disposition: "inline",
          contentId: "logo-1",
        }),
      ]),
    ).not.toThrow();
  });

  it("passes an empty array", () => {
    expect(() => assertValidAttachments([])).not.toThrow();
  });

  it("rejects more than MAX_ATTACHMENT_COUNT, naming both numbers", () => {
    const many = Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, (_, i) =>
      att({ filename: `file-${i}.pdf` }),
    );
    let message = "";
    try {
      assertValidAttachments(many);
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidAttachmentError);
      message = (err as Error).message;
    }
    expect(message).toContain(String(MAX_ATTACHMENT_COUNT + 1));
    expect(message).toContain(String(MAX_ATTACHMENT_COUNT));
  });

  it("rejects an empty filename, naming the offender by index", () => {
    expect(() =>
      assertValidAttachments([att(), att({ filename: "" })]),
    ).toThrow(/attachment 1/);
  });

  it("throws InvalidAttachmentError, NOT TypeError, on a missing filename", () => {
    // The shared validator is reached by JS consumers with no compiler, so an
    // object without a filename is ordinary input. The error TYPE is what
    // decides 400-vs-500 at the relay (`code` mapping) — a raw TypeError here
    // would escape as "we broke" instead of "your input was wrong".
    const broken = {
      content: new Uint8Array([1]),
    } as unknown as EmailAttachment;
    let caught: unknown;
    try {
      assertValidAttachments([broken]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidAttachmentError);
    expect((caught as Error).message).toContain("attachment 0");
  });

  it("throws InvalidAttachmentError on a non-string contentType", () => {
    const broken = att({ contentType: 42 as unknown as string });
    expect(() => assertValidAttachments([broken])).toThrow(
      InvalidAttachmentError,
    );
  });

  it("throws InvalidAttachmentError on a non-string contentId", () => {
    const broken = att({ contentId: 42 as unknown as string });
    expect(() => assertValidAttachments([broken])).toThrow(
      InvalidAttachmentError,
    );
  });

  it("rejects a whitespace-only filename", () => {
    expect(() => assertValidAttachments([att({ filename: "   " })])).toThrow(
      InvalidAttachmentError,
    );
  });

  it.each([
    ["CR", "bad\rname.pdf"],
    ["LF", "bad\nname.pdf"],
    ["NUL", "bad\u0000name.pdf"],
  ])("rejects a filename containing %s", (_label, filename) => {
    expect(() => assertValidAttachments([att({ filename })])).toThrow(
      /CR, LF or NUL/,
    );
  });

  it("rejects a filename over ATTACHMENT_FILENAME_MAX", () => {
    const filename = `${"a".repeat(ATTACHMENT_FILENAME_MAX)}.pdf`;
    expect(() => assertValidAttachments([att({ filename })])).toThrow(
      new RegExp(String(ATTACHMENT_FILENAME_MAX)),
    );
  });

  it("rejects a contentType over ATTACHMENT_CONTENT_TYPE_MAX, naming the file", () => {
    // The real-world shape that blows the 78-char cap: a multipart value with
    // a boundary parameter.
    const contentType = `multipart/mixed; boundary="${"b".repeat(70)}"`;
    expect(contentType.length).toBeGreaterThan(ATTACHMENT_CONTENT_TYPE_MAX);
    let message = "";
    try {
      assertValidAttachments([att({ filename: "report.pdf", contentType })]);
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidAttachmentError);
      message = (err as Error).message;
    }
    // A filename-based error must carry the filename — an operator reading a
    // 400 needs to know WHICH file.
    expect(message).toContain("report.pdf");
    expect(message).toContain(String(ATTACHMENT_CONTENT_TYPE_MAX));
  });

  it("rejects a contentType containing CR/LF", () => {
    expect(() =>
      assertValidAttachments([att({ contentType: "text/plain\r\nX-Evil: 1" })]),
    ).toThrow(/CR, LF or NUL/);
  });

  it("rejects an empty contentId when present", () => {
    expect(() => assertValidAttachments([att({ contentId: "" })])).toThrow(
      /empty contentId/,
    );
  });

  it("rejects a contentId over ATTACHMENT_CONTENT_ID_MAX", () => {
    expect(() =>
      assertValidAttachments([
        att({ contentId: "c".repeat(ATTACHMENT_CONTENT_ID_MAX + 1) }),
      ]),
    ).toThrow(new RegExp(String(ATTACHMENT_CONTENT_ID_MAX)));
  });

  it("rejects a total over MAX_ATTACHMENT_BYTES, stating limit AND actual", () => {
    const oversize = att({ content: new Uint8Array(MAX_ATTACHMENT_BYTES + 1) });
    let message = "";
    try {
      assertValidAttachments([oversize]);
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidAttachmentError);
      expect((err as InvalidAttachmentError).code).toBe("invalid_attachment");
      message = (err as Error).message;
    }
    expect(message).toContain(String(MAX_ATTACHMENT_BYTES));
    expect(message).toContain(String(MAX_ATTACHMENT_BYTES + 1));
    // The at-a-glance form rides alongside the exact counts — two nine-digit
    // numbers differing in the last digit are unreadable in a 400 body.
    expect(message).toContain("MiB");
  });

  it("enforces the byte cap on the SUM across attachments", () => {
    // Two files individually under the cap, jointly over it — the cap is on
    // the TOTAL, not per-file. (Decoded-vs-encoded counting is pinned in the
    // attachmentByteLength suite; this asserts summation.)
    const half = Math.ceil(MAX_ATTACHMENT_BYTES / 2) + 1;
    expect(() =>
      assertValidAttachments([
        att({ filename: "a.bin", content: new Uint8Array(half) }),
        att({ filename: "b.bin", content: new Uint8Array(half) }),
      ]),
    ).toThrow(InvalidAttachmentError);
  });
});
