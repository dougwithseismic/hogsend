import { describe, expectTypeOf, it } from "vitest";
import type { EmailEvent, EmailEventType, WebhookHandlerMap } from "./email.js";

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
