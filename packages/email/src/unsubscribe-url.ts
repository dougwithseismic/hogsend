import { generateUnsubscribeToken } from "./unsubscribe-tokens.js";

export interface UnsubscribeUrlOptions {
  baseUrl: string;
  secret: string;
  externalId: string;
  email: string;
  category?: string;
}

export function generateUnsubscribeUrl(options: UnsubscribeUrlOptions): string {
  const { baseUrl, secret, externalId, email, category } = options;

  const token = generateUnsubscribeToken({
    secret,
    externalId,
    email,
    category,
    action: "unsubscribe",
  });

  return `${baseUrl}/v1/email/unsubscribe?token=${encodeURIComponent(token)}`;
}

export function generatePreferenceCenterUrl(
  options: Omit<UnsubscribeUrlOptions, "category">,
): string {
  const { baseUrl, secret, externalId, email } = options;

  const token = generateUnsubscribeToken({
    secret,
    externalId,
    email,
    action: "manage",
  });

  return `${baseUrl}/v1/email/preferences?token=${encodeURIComponent(token)}`;
}
