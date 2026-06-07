import type { HttpClient } from "../internal/http.js";
import type { SendEmailInput, SendEmailResult } from "../types.js";

/** The `emails.*` resource bound to an {@link HttpClient}. */
export class EmailsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Send a transactional email by template. Recipient is `to` (raw address) or
   * `userId` (resolved server-side). `template`/`props` are type-checked against
   * the augmented `TemplateRegistryMap` when `@hogsend/email` is installed,
   * else degrade to `{ template: string; props? }`.
   */
  send(input: SendEmailInput): Promise<SendEmailResult> {
    // The discriminated union narrows `template`/`props`; index into the input
    // via a permissive view to build the wire body without re-discriminating.
    const body = input as SendEmailInput & {
      props?: Record<string, unknown>;
    };
    return this.http.post<SendEmailResult>(
      "/v1/emails",
      {
        to: body.to,
        userId: body.userId,
        template: body.template,
        props: body.props,
        from: body.from,
        subject: body.subject,
        replyTo: body.replyTo,
        category: body.category,
        skipPreferenceCheck: body.skipPreferenceCheck,
        idempotencyKey: body.idempotencyKey,
      },
      body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : undefined,
    );
  }
}
