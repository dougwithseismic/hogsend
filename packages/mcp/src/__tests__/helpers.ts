import type { AdminClient, Query } from "../lib/admin-client.js";

/** A recorded admin-client call, for asserting paths/bodies in tests. */
export interface RecordedCall {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
  query?: Query;
}

/** Build an {@link import("../lib/admin-client.js").HttpError}-shaped error. */
export function httpError(status: number, body: unknown): Error {
  const message =
    body && typeof body === "object" && "error" in body
      ? String((body as { error: unknown }).error)
      : `request failed with status ${status}`;
  const err = new Error(message) as Error & { status: number; body: unknown };
  err.name = "HttpError";
  err.status = status;
  err.body = body;
  return err;
}

type Handler = (arg: {
  path: string;
  body?: unknown;
  query?: Query;
}) => unknown;

export interface MockHandlers {
  get?: Handler;
  post?: Handler;
  patch?: Handler;
}

/**
 * A recording, no-network {@link AdminClient}. Each verb delegates to the
 * matching handler (which may return a value/Promise, or THROW an
 * {@link httpError} to exercise error mapping). Every call is pushed to `calls`.
 */
export function makeClient(handlers: MockHandlers): {
  client: AdminClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const wrap =
    (method: RecordedCall["method"], h?: Handler) =>
    async (path: string, a?: unknown) => {
      const body = method === "GET" ? undefined : a;
      const query = method === "GET" ? (a as Query | undefined) : undefined;
      calls.push({ method, path, body, query });
      if (!h)
        throw httpError(500, { error: `no handler for ${method} ${path}` });
      return h({ path, body, query });
    };
  const client: AdminClient = {
    get: wrap("GET", handlers.get) as AdminClient["get"],
    post: wrap("POST", handlers.post) as AdminClient["post"],
    patch: wrap("PATCH", handlers.patch) as AdminClient["patch"],
  };
  return { client, calls };
}
