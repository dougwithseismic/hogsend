import { createHmac, timingSafeEqual } from "node:crypto";

export type TokenAction = "unsubscribe" | "resubscribe" | "manage";

export interface UnsubscribeTokenPayload {
  externalId: string;
  email: string;
  category?: string;
  action: TokenAction;
  exp: number;
}

export interface TokenOptions {
  secret: string;
  externalId: string;
  email: string;
  category?: string;
  action: TokenAction;
  expiresInSeconds?: number;
  /** Clock snapshot used to calculate expiry. Defaults to the current time. */
  now?: Date;
}

export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTokenError";
  }
}

const DEFAULT_EXPIRY_SECONDS = 30 * 24 * 3600; // 30 days

function toBase64Url(data: string): string {
  return Buffer.from(data).toString("base64url");
}

function fromBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function generateUnsubscribeToken(options: TokenOptions): string {
  const {
    secret,
    externalId,
    email,
    category,
    action,
    expiresInSeconds = DEFAULT_EXPIRY_SECONDS,
    now = new Date(),
  } = options;

  const payload: UnsubscribeTokenPayload = {
    externalId,
    email,
    action,
    exp: Math.floor(now.getTime() / 1000) + expiresInSeconds,
  };

  if (category) {
    payload.category = category;
  }

  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = sign(encodedPayload, secret);

  return `${encodedPayload}.${signature}`;
}

export function validateUnsubscribeToken(opts: {
  token: string;
  secret: string;
}): UnsubscribeTokenPayload {
  const { token, secret } = opts;
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new InvalidTokenError("Malformed token");
  }

  const [encodedPayload, signature] = parts as [string, string];

  const expectedSignature = sign(encodedPayload, secret);

  const sigBuffer = Buffer.from(signature, "base64url");
  const expectedBuffer = Buffer.from(expectedSignature, "base64url");

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    throw new InvalidTokenError("Invalid token signature");
  }

  let payload: UnsubscribeTokenPayload;
  try {
    payload = JSON.parse(fromBase64Url(encodedPayload));
  } catch {
    throw new InvalidTokenError("Malformed token payload");
  }

  if (
    !payload.externalId ||
    !payload.email ||
    !payload.action ||
    !payload.exp
  ) {
    throw new InvalidTokenError("Incomplete token payload");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    throw new InvalidTokenError("Token has expired");
  }

  return payload;
}
