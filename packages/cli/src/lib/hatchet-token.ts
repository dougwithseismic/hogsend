/**
 * Headless Hatchet API-token minting against a hatchet-lite instance.
 *
 * Drives hatchet-lite's REST API end to end so HATCHET_CLIENT_TOKEN never has
 * to be copied out of the dashboard by hand:
 *
 *   1. POST /api/v1/users/register   (best-effort — falls back to login when
 *      the account exists or signups are disabled via SERVER_ALLOW_SIGNUP=false)
 *   2. POST /api/v1/users/login      → session cookie
 *   3. GET  /api/v1/users/memberships → find the tenant by slug
 *   4. POST /api/v1/tenants          → create it if missing (engineVersion V1)
 *   5. POST /api/v1/tenants/{id}/api-tokens → the JWT
 *
 * Endpoint paths + request shapes verified against hatchet-dev/hatchet
 * api-contracts/openapi (UserRegisterRequest, UserLoginRequest,
 * CreateTenantRequest, CreateAPITokenRequest/Response).
 *
 * Pure + injectable (fetch, progress sink) so the flow is unit-testable
 * without a live Hatchet.
 */

/** Hatchet's `hatchetName` slug validator (lowercase alnum + dashes). */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export interface MintHatchetTokenOptions {
  /** Hatchet base URL, e.g. https://hatchet-lite-production.up.railway.app */
  url: string;
  email: string;
  password: string;
  /** Tenant slug to mint the token in. Default "default" (the seeded tenant). */
  tenantSlug?: string;
  /** Display name for the minted API token. Default "hogsend". */
  tokenName?: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Progress sink (the CLI points this at stderr). Default: silent. */
  onProgress?: (message: string) => void;
}

export interface MintHatchetTokenResult {
  /** The minted Hatchet API token (the HATCHET_CLIENT_TOKEN value). */
  token: string;
  tenantId: string;
  tenantSlug: string;
  /** True when this run created the tenant (vs found an existing membership). */
  createdTenant: boolean;
  /** True when this run registered the user (vs logged into an existing one). */
  registered: boolean;
}

export class HatchetTokenError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "HatchetTokenError";
    this.status = status;
  }
}

/** Hatchet's APIErrors envelope: { errors: [{ description }] }. */
function extractApiError(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return undefined;
  const descriptions = errors
    .map((e) =>
      typeof e === "object" && e !== null
        ? (e as { description?: unknown }).description
        : undefined,
    )
    .filter((d): d is string => typeof d === "string");
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
  const setCookies = res.headers.getSetCookie();
  return setCookies
    .map((c) => c.split(";", 1)[0] ?? "")
    .filter((c) => c.includes("="))
    .join("; ");
}

interface TenantRef {
  id: string;
  slug: string;
}

interface MembershipsResponse {
  rows?: Array<{
    tenant?: {
      metadata?: { id?: string };
      slug?: string;
    };
  }>;
}

/**
 * Register-or-login → ensure tenant → mint an API token. Returns the token;
 * throws {@link HatchetTokenError} with the Hatchet error description on any
 * hard failure (bad credentials, slug taken by another account, etc.).
 */
export async function mintHatchetToken(
  opts: MintHatchetTokenOptions,
): Promise<MintHatchetTokenResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const progress = opts.onProgress ?? (() => {});
  const base = opts.url.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) {
    throw new HatchetTokenError(
      `invalid --url "${opts.url}" (expected http(s)://...)`,
    );
  }
  const tenantSlug = opts.tenantSlug ?? "default";
  if (!SLUG_RE.test(tenantSlug)) {
    throw new HatchetTokenError(
      `invalid tenant slug "${tenantSlug}" (lowercase letters, digits, dashes)`,
    );
  }
  const tokenName = opts.tokenName ?? "hogsend";

  const postJson = (path: string, body: unknown, cookie?: string) =>
    fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });

  // 1. Register (best-effort). 4xx falls through to login — covers both
  //    "email is already registered" and a locked-down instance
  //    (SERVER_ALLOW_SIGNUP=false → 400, basic auth disabled → 405).
  let registered = false;
  progress(`registering ${opts.email} ...`);
  const registerRes = await postJson("/api/v1/users/register", {
    name: opts.email.split("@")[0] || opts.email,
    email: opts.email,
    password: opts.password,
  });
  if (registerRes.ok) {
    registered = true;
    await readBody(registerRes); // drain
  } else if (registerRes.status >= 500) {
    const msg = extractApiError(await readBody(registerRes));
    throw new HatchetTokenError(
      `Hatchet register failed (${registerRes.status})${msg ? `: ${msg}` : ""}`,
      registerRes.status,
    );
  } else {
    await readBody(registerRes); // drain; fall back to login
    progress("registration unavailable or account exists — logging in ...");
  }

  // 2. Login → session cookie.
  const loginRes = await postJson("/api/v1/users/login", {
    email: opts.email,
    password: opts.password,
  });
  if (!loginRes.ok) {
    const msg = extractApiError(await readBody(loginRes));
    throw new HatchetTokenError(
      `Hatchet login failed (${loginRes.status})${msg ? `: ${msg}` : ""} — ` +
        "check --email/--password (on a locked-down hatchet-lite these are " +
        "its ADMIN_EMAIL/ADMIN_PASSWORD)",
      loginRes.status,
    );
  }
  await readBody(loginRes); // drain
  const cookie = cookieHeaderFrom(loginRes);
  if (!cookie) {
    throw new HatchetTokenError(
      "Hatchet login succeeded but returned no session cookie",
    );
  }

  // 3. Find the tenant among the user's memberships.
  progress(`resolving tenant "${tenantSlug}" ...`);
  const membershipsRes = await fetchImpl(`${base}/api/v1/users/memberships`, {
    headers: { cookie },
  });
  if (!membershipsRes.ok) {
    const msg = extractApiError(await readBody(membershipsRes));
    throw new HatchetTokenError(
      `failed to list tenant memberships (${membershipsRes.status})${msg ? `: ${msg}` : ""}`,
      membershipsRes.status,
    );
  }
  const memberships = (await readBody(membershipsRes)) as MembershipsResponse;
  let tenant: TenantRef | undefined;
  for (const row of memberships?.rows ?? []) {
    const id = row.tenant?.metadata?.id;
    if (id && row.tenant?.slug === tenantSlug) {
      tenant = { id, slug: tenantSlug };
      break;
    }
  }

  // 4. Create the tenant when missing.
  let createdTenant = false;
  if (!tenant) {
    progress(`creating tenant "${tenantSlug}" ...`);
    const createRes = await postJson(
      "/api/v1/tenants",
      { name: tenantSlug, slug: tenantSlug, engineVersion: "V1" },
      cookie,
    );
    const createBody = await readBody(createRes);
    if (!createRes.ok) {
      const msg = extractApiError(createBody);
      throw new HatchetTokenError(
        `failed to create tenant "${tenantSlug}" (${createRes.status})${msg ? `: ${msg}` : ""}`,
        createRes.status,
      );
    }
    const created = createBody as {
      metadata?: { id?: string };
      slug?: string;
    };
    const id = created?.metadata?.id;
    if (!id) {
      throw new HatchetTokenError(
        "tenant create succeeded but the response had no id",
      );
    }
    tenant = { id, slug: tenantSlug };
    createdTenant = true;
  }

  // 5. Mint the API token.
  progress(`minting API token "${tokenName}" ...`);
  const tokenRes = await postJson(
    `/api/v1/tenants/${tenant.id}/api-tokens`,
    { name: tokenName },
    cookie,
  );
  const tokenBody = await readBody(tokenRes);
  if (!tokenRes.ok) {
    const msg = extractApiError(tokenBody);
    throw new HatchetTokenError(
      `failed to mint API token (${tokenRes.status})${msg ? `: ${msg}` : ""}`,
      tokenRes.status,
    );
  }
  const token = (tokenBody as { token?: unknown })?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new HatchetTokenError(
      "token create succeeded but the response had no token",
    );
  }

  return {
    token,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    createdTenant,
    registered,
  };
}
