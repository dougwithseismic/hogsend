import { handleDomainCreate, handleDomainGet } from "@/src/lib/email-domains";

/**
 * `GET /api/email/domains?domain=…` and `POST /api/email/domains` — the
 * control-plane surface behind `plugin-hogsend`'s `domains` capability (PRD 07
 * task 4). A tenant instance has no AWS access; the relay token is the whole
 * credential.
 *
 * Three lines each, like the send relay's, because the decisions they make are
 * shared and a per-route copy of an ordering that is a security posture is how
 * one of them quietly loses a step. Everything lives in
 * `src/lib/email-domains.ts`.
 *
 * NOT in `src/openapi.ts`: that file describes the UNAUTHENTICATED surface, and
 * the token-authenticated machine routes are excluded because our own software
 * is their only consumer.
 */

// Reads a bearer credential and talks to SES; nothing here may be cached.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleDomainGet(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleDomainCreate(request);
}
