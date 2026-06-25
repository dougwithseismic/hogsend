import { createHash, randomBytes } from "node:crypto";

const PREFIX_LENGTH = 8;

export function generateApiKey(opts?: { publishable?: boolean }): {
  key: string;
  prefix: string;
  hash: string;
} {
  const raw = randomBytes(32).toString("base64url");
  // Publishable (browser-safe) keys are minted with the `pk_` class prefix;
  // secret server keys keep `hsk_`. The class lives ENTIRELY in the raw token's
  // prefix — no DB column — so the request guard can branch on the bearer's
  // prefix before any DB work (the CORS preflight carries no bearer, so the
  // class is unknowable at the CORS layer; the guard is the boundary).
  const key = `${opts?.publishable ? "pk_" : "hsk_"}${raw}`;
  const prefix = key.slice(0, PREFIX_LENGTH);
  const hash = hashApiKey(key);
  return { key, prefix, hash };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
