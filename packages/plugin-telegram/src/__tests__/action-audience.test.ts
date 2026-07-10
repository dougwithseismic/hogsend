import { describe, expect, it } from "vitest";
import { dm, sendMessage } from "../actions/index.js";

/**
 * The audience contract for the Telegram actions: both `dm` and `sendMessage`
 * are member-directed (so they mint a `telegram` channel + get preference-gated).
 * A linked telegram contact is keyed `externalId = "telegram:<chatId>"`, so the
 * extractors surface the namespaced candidate a raw chat id needs to resolve.
 */
describe("telegram action audiences", () => {
  it("dm yields [to, telegram:to] candidates in order", () => {
    expect(dm.audience?.kind).toBe("member");
    // An email/external-id `to` matches the FIRST candidate directly.
    expect(dm.audience?.ref({ to: "user@example.com", text: "hi" })).toEqual([
      "user@example.com",
      "telegram:user@example.com",
    ]);
    // A raw chat-id `to` resolves via the SECOND (namespaced) candidate.
    expect(dm.audience?.ref({ to: "12345", text: "hi" })).toEqual([
      "12345",
      "telegram:12345",
    ]);
  });

  it("sendMessage namespaces the chat id (string or number)", () => {
    expect(sendMessage.audience?.kind).toBe("member");
    expect(sendMessage.audience?.ref({ chatId: 12345, text: "hi" })).toBe(
      "telegram:12345",
    );
    expect(sendMessage.audience?.ref({ chatId: "12345", text: "hi" })).toBe(
      "telegram:12345",
    );
    // A group chat (negative id) still produces a namespaced ref — it simply
    // never resolves a contact, so the engine gate allows the send.
    expect(sendMessage.audience?.ref({ chatId: -100987, text: "hi" })).toBe(
      "telegram:-100987",
    );
  });
});
