import { handleBulkImportCheck } from "@/src/lib/email-bulk-import";

/**
 * `POST /api/email/bulk-import` — may this environment import a list?
 * (PRD 08 task 6, AUP §5.3.)
 *
 * The control plane owns the ANSWER because it owns the trust tier; the
 * instance owns the contacts and does the importing. Same relay token, same
 * posture as the send and domain routes: the token resolves an environment, and
 * a request may not name a tier or an environment of its own.
 */

// Reads a bearer credential and tenant state; nothing here may be cached.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleBulkImportCheck(request);
}
