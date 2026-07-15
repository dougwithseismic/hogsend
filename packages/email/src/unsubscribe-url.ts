import { generateUnsubscribeToken } from "./unsubscribe-tokens.js";

export interface UnsubscribeUrlOptions {
  baseUrl: string;
  secret: string;
  externalId: string;
  email: string;
  category?: string;
  /** Clock snapshot forwarded to token generation. */
  now?: Date;
}

export function generateUnsubscribeUrl(options: UnsubscribeUrlOptions): string {
  const { baseUrl, secret, externalId, email, category, now } = options;

  const token = generateUnsubscribeToken({
    secret,
    externalId,
    email,
    category,
    action: "unsubscribe",
    now,
  });

  return `${baseUrl}/v1/email/unsubscribe?token=${encodeURIComponent(token)}`;
}

export function generatePreferenceCenterUrl(
  options: Omit<UnsubscribeUrlOptions, "category">,
): string {
  const { baseUrl, secret, externalId, email, now } = options;

  const token = generateUnsubscribeToken({
    secret,
    externalId,
    email,
    action: "manage",
    now,
  });

  return `${baseUrl}/v1/email/preferences?token=${encodeURIComponent(token)}`;
}
