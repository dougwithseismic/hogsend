import { config } from "./config";

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

type RequestOptions = Omit<RequestInit, "body"> & {
  /** JSON body — serialized automatically with the correct content-type. */
  json?: unknown;
  /** Query params appended to the URL. */
  query?: Record<string, string | number | boolean | undefined | null>;
};

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const base = config.baseUrl;
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * Thin fetch wrapper for the Hogsend API.
 *
 * - Always sends cookies (`credentials: "include"`) so the Better Auth session
 *   travels with every request, same-origin or cross-origin.
 * - Serializes/parses JSON and throws `ApiError` on non-2xx responses.
 */
async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { json, query, headers, ...rest } = options;
  const init: RequestInit = {
    credentials: "include",
    ...rest,
    headers: {
      Accept: "application/json",
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
  };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
  }

  const res = await fetch(buildUrl(path, query), init);

  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const payload = isJson
    ? await res.json().catch(() => null)
    : await res.text().catch(() => null);

  if (!res.ok) {
    const message =
      (isJson &&
      payload &&
      typeof payload === "object" &&
      "message" in payload &&
      typeof (payload as { message: unknown }).message === "string"
        ? (payload as { message: string }).message
        : null) ?? `Request failed with status ${res.status}`;
    throw new ApiError(res.status, message, payload);
  }

  return payload as T;
}

export const api = {
  request,
  get: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "POST" }),
  put: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "PUT" }),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "DELETE" }),
};

/** Shape returned by GET /v1/auth/status (unauthenticated bootstrap probe). */
export type AuthStatus = {
  needsSetup: boolean;
};

export function getAuthStatus(): Promise<AuthStatus> {
  return api.get<AuthStatus>("/v1/auth/status");
}
