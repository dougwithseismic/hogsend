import { createHash, randomBytes } from "node:crypto";

const PREFIX_LENGTH = 8;

export function generateApiKey(): {
  key: string;
  prefix: string;
  hash: string;
} {
  const raw = randomBytes(32).toString("base64url");
  const key = `hsk_${raw}`;
  const prefix = key.slice(0, PREFIX_LENGTH);
  const hash = hashApiKey(key);
  return { key, prefix, hash };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
