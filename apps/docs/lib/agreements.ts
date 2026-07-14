import { postToHogsendApi } from "@/lib/hogsend-api";

/**
 * Server-side read of the customer's service agreements (code-first docs on
 * the Hono API + this customer's signature state) — same wire + fail-soft
 * contract as lib/services. Null means "couldn't load"; an empty list means
 * no active agreements (the portal hides the section).
 */

export type Agreement = {
  docId: string;
  version: string;
  /** sha256 of the served body — echoed back on sign as proof of what was shown. */
  contentHash: string;
  title: string;
  summary: string;
  body: string;
  signed: { signedName: string; signedAt: string } | null;
};

function sanitize(entry: unknown): Agreement | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (
    typeof e.docId !== "string" ||
    typeof e.version !== "string" ||
    typeof e.contentHash !== "string" ||
    typeof e.title !== "string" ||
    typeof e.body !== "string"
  ) {
    return null;
  }
  const s = e.signed as Record<string, unknown> | null | undefined;
  return {
    docId: e.docId,
    version: e.version,
    contentHash: e.contentHash,
    title: e.title,
    summary: typeof e.summary === "string" ? e.summary : "",
    body: e.body,
    signed:
      s && typeof s.signedName === "string" && typeof s.signedAt === "string"
        ? { signedName: s.signedName, signedAt: s.signedAt }
        : null,
  };
}

export async function fetchAgreements(input: {
  email: string;
  userId?: string;
}): Promise<Agreement[] | null> {
  const data = await postToHogsendApi<{ agreements?: unknown }>(
    "/me/agreements",
    input,
  );
  if (!data || !Array.isArray(data.agreements)) return null;
  return data.agreements
    .map(sanitize)
    .filter((a): a is Agreement => a !== null);
}
