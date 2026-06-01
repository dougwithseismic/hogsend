import { Resend } from "resend";

export function createResendClient(opts: { apiKey: string }): Resend {
  return new Resend(opts.apiKey);
}
