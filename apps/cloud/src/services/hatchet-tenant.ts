import { env } from "../env";
import { CloudServiceError } from "./errors";

/**
 * Headless Hatchet tenant + API-token minting against a CELL's Hatchet engine.
 *
 * A port of the flow `@hogsend/cli` already proves against real hatchet-lite
 * instances (`packages/cli/src/lib/hatchet-token.ts`) — endpoints, payload
 * shapes and the cookie handling come from there, not from invention:
 *
 *   1. POST /api/v1/users/register        (best-effort; 4xx falls through)
 *   2. POST /api/v1/users/login           → session cookie
 *   3. GET  /api/v1/users/memberships     → find the tenant by slug
 *   4. POST /api/v1/tenants               → create it when missing (V1)
 *   5. POST /api/v1/tenants/{id}/api-tokens → the JWT
 *
 * It is copied rather than imported: the control plane does not depend on the
 * consumer CLI, and this is the seam where a hosted Hatchet's auth would
 * diverge first.
 *
 * IDEMPOTENCY: steps 1–4 converge on one tenant per slug — a re-run finds the
 * membership and creates nothing. Step 5 does NOT dedupe, and must not: Hatchet
 * tokens are additive and unreadable after minting, so a replayed provisioning
 * step needs a fresh usable token, not a reference to one nobody holds. The
 * superseded token stays valid (revoking it would break a stack that is already
 * running on it); ops revokes from the Hatchet dashboard.
 */

/** Hatchet's `hatchetName` slug validator (lowercase alnum + dashes). */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Any hard failure of the mint flow. */
export class HatchetTenantError extends CloudServiceError {
  readonly code = "hatchet_tenant_failed";
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface MintTenantTokenInput {
  /** The cell's Hatchet base URL (`cells.shared_hatchet_url`). */
  hatchetUrl: string;
  /** Tenant slug — the provisioner passes the stack id's namespace. */
  tenantSlug: string;
  /** Defaults to `CLOUD_HATCHET_ADMIN_EMAIL`. */
  adminEmail?: string;
  /** Defaults to `CLOUD_HATCHET_ADMIN_PASSWORD`. NEVER logged. */
  adminPassword?: string;
  /** Display name of the minted token in the Hatchet dashboard. */
  tokenName?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface MintTenantTokenResult {
  /** The HATCHET_CLIENT_TOKEN value for the tenant stack. NEVER logged. */
  token: string;
  tenantId: string;
  tenantSlug: string;
  /** True when THIS run created the tenant. */
  createdTenant: boolean;
  /** True when THIS run registered the admin account. */
  registered: boolean;
}

/** Hatchet's APIErrors envelope: `{ errors: [{ description }] }`. */
function extractApiError(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return undefined;
  const descriptions = errors
    .map((entry) =>
      typeof entry === "object" && entry !== null
        ? (entry as { description?: unknown }).description
        : undefined,
    )
    .filter(
      (description): description is string => typeof description === "string",
    );
  return descriptions.length > 0 ? descriptions.join("; ") : undefined;
}

async function readBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** Build a Cookie header from the response's Set-Cookie headers. */
function cookieHeaderFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0] ?? "")
    .filter((cookie) => cookie.includes("="))
    .join("; ");
}

interface MembershipsResponse {
  rows?: Array<{ tenant?: { metadata?: { id?: string }; slug?: string } }>;
}

export class HatchetTenantService {
  async mintToken(input: MintTenantTokenInput): Promise<MintTenantTokenResult> {
    const fetchImpl = input.fetchImpl ?? fetch;
    const base = input.hatchetUrl.replace(/\/+$/, "");
    if (!/^https?:\/\//.test(base)) {
      throw new HatchetTenantError(
        `Invalid Hatchet url "${input.hatchetUrl}" (expected http(s)://…)`,
      );
    }
    const tenantSlug = input.tenantSlug;
    if (!SLUG_RE.test(tenantSlug) || tenantSlug.length > 63) {
      throw new HatchetTenantError(
        `Invalid Hatchet tenant slug "${tenantSlug}" (lowercase letters, digits, dashes)`,
      );
    }

    const email = input.adminEmail ?? env.CLOUD_HATCHET_ADMIN_EMAIL;
    const password = input.adminPassword ?? env.CLOUD_HATCHET_ADMIN_PASSWORD;
    if (!email || !password) {
      // Fail CLOSED. Production withholds the dev defaults, so a deploy that
      // never configured a cell admin must be told so, not silently retried.
      throw new HatchetTenantError(
        "No Hatchet admin credentials configured — set CLOUD_HATCHET_ADMIN_EMAIL and CLOUD_HATCHET_ADMIN_PASSWORD",
      );
    }
    const tokenName = input.tokenName ?? `hogsend-${tenantSlug}`;

    const postJson = (path: string, body: unknown, cookie?: string) =>
      fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      });

    // 1. Register, best-effort. A 4xx covers both "already registered" and a
    //    locked-down instance (SERVER_ALLOW_SIGNUP=false) — both mean "log in".
    let registered = false;
    const registerRes = await postJson("/api/v1/users/register", {
      name: email.split("@")[0] || email,
      email,
      password,
    });
    const registerBody = await readBody(registerRes);
    if (registerRes.ok) {
      registered = true;
    } else if (registerRes.status >= 500) {
      const message = extractApiError(registerBody);
      throw new HatchetTenantError(
        `Hatchet register failed (${registerRes.status})${message ? `: ${message}` : ""}`,
        registerRes.status,
      );
    }

    // 2. Login → session cookie.
    const loginRes = await postJson("/api/v1/users/login", { email, password });
    const loginBody = await readBody(loginRes);
    if (!loginRes.ok) {
      const message = extractApiError(loginBody);
      throw new HatchetTenantError(
        `Hatchet login failed (${loginRes.status})${message ? `: ${message}` : ""} — check CLOUD_HATCHET_ADMIN_EMAIL / CLOUD_HATCHET_ADMIN_PASSWORD`,
        loginRes.status,
      );
    }
    const cookie = cookieHeaderFrom(loginRes);
    if (!cookie) {
      throw new HatchetTenantError(
        "Hatchet login succeeded but returned no session cookie",
      );
    }

    // 3. Resolve the tenant from the admin's memberships.
    const membershipsRes = await fetchImpl(`${base}/api/v1/users/memberships`, {
      headers: { cookie },
    });
    const membershipsBody = await readBody(membershipsRes);
    if (!membershipsRes.ok) {
      const message = extractApiError(membershipsBody);
      throw new HatchetTenantError(
        `Failed to list Hatchet tenant memberships (${membershipsRes.status})${message ? `: ${message}` : ""}`,
        membershipsRes.status,
      );
    }
    let tenantId: string | undefined;
    for (const row of (membershipsBody as MembershipsResponse)?.rows ?? []) {
      if (row.tenant?.slug === tenantSlug && row.tenant?.metadata?.id) {
        tenantId = row.tenant.metadata.id;
        break;
      }
    }

    // 4. Create the tenant when missing.
    let createdTenant = false;
    if (!tenantId) {
      const createRes = await postJson(
        "/api/v1/tenants",
        { name: tenantSlug, slug: tenantSlug, engineVersion: "V1" },
        cookie,
      );
      const createBody = await readBody(createRes);
      if (!createRes.ok) {
        const message = extractApiError(createBody);
        throw new HatchetTenantError(
          `Failed to create Hatchet tenant "${tenantSlug}" (${createRes.status})${message ? `: ${message}` : ""}`,
          createRes.status,
        );
      }
      const id = (createBody as { metadata?: { id?: string } })?.metadata?.id;
      if (!id) {
        throw new HatchetTenantError(
          "Hatchet tenant create succeeded but the response carried no id",
        );
      }
      tenantId = id;
      createdTenant = true;
    }

    // 5. Mint the API token.
    const tokenRes = await postJson(
      `/api/v1/tenants/${tenantId}/api-tokens`,
      { name: tokenName },
      cookie,
    );
    const tokenBody = await readBody(tokenRes);
    if (!tokenRes.ok) {
      const message = extractApiError(tokenBody);
      throw new HatchetTenantError(
        `Failed to mint Hatchet API token (${tokenRes.status})${message ? `: ${message}` : ""}`,
        tokenRes.status,
      );
    }
    const token = (tokenBody as { token?: unknown })?.token;
    if (typeof token !== "string" || token.length === 0) {
      throw new HatchetTenantError(
        "Hatchet token create succeeded but the response carried no token",
      );
    }

    return { token, tenantId, tenantSlug, createdTenant, registered };
  }
}
