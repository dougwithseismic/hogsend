import { createServer, type Server } from "node:http";
import { CALLBACK_PATH, CALLBACK_TIMEOUT_MS } from "./oauth.js";

/**
 * RFC 8252 loopback redirect receiver for the OAuth callback. Binds
 * 127.0.0.1 ONLY (never 0.0.0.0), tries the fixed port list in order
 * (production: `LOOPBACK_PORTS`, registered in the CIMD document; tests
 * inject `[0]` for ephemeral binds), and settles exactly once — later
 * requests get a 410.
 */

export type LoopbackFailure =
  | "ports_busy"
  | "state_mismatch"
  | "consent_denied"
  | "timeout"
  | "oauth_error";

export class LoopbackError extends Error {
  readonly reason: LoopbackFailure;
  readonly detail?: string;

  constructor(reason: LoopbackFailure, message: string, detail?: string) {
    super(message);
    this.name = "LoopbackError";
    this.reason = reason;
    this.detail = detail;
  }
}

export interface LoopbackServer {
  port: number;
  /** `http://127.0.0.1:${port}${callbackPath}` */
  redirectUri: string;
  waitForCallback(opts?: { timeoutMs?: number }): Promise<{ code: string }>;
  close(): Promise<void>;
}

const page = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Hogsend</title>` +
  `<style>body{font-family:system-ui,sans-serif;max-width:32rem;` +
  `margin:6rem auto;padding:0 1rem;color:#1a1a1a}</style></head>` +
  `<body><h1>${title}</h1><p>${body}</p></body></html>`;

const SUCCESS_HTML = page(
  "Connected",
  "You can close this tab and return to your terminal.",
);
const DENIED_HTML = page(
  "Not connected",
  "Authorization was denied. Close this tab and re-run the command if that " +
    "was a mistake.",
);
const MISMATCH_HTML = page(
  "Not connected",
  "State mismatch. Close this tab and re-run the command.",
);
const NO_CODE_HTML = page(
  "Not connected",
  "The callback carried no authorization code. Close this tab and re-run " +
    "the command.",
);

/** Bind to 127.0.0.1:port; resolves null on EADDRINUSE, rejects otherwise. */
function tryListen(
  port: number,
  handler: Parameters<typeof createServer>[1],
): Promise<Server | null> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    const onError = (err: NodeJS.ErrnoException) => {
      server.close();
      if (err.code === "EADDRINUSE") resolve(null);
      else reject(err);
    };
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.removeListener("error", onError);
      resolve(server);
    });
  });
}

export async function startLoopbackServer(opts: {
  /** Production: LOOPBACK_PORTS; tests inject [0] for an ephemeral bind. */
  ports: readonly number[];
  state: string;
  /** Default CALLBACK_PATH. */
  callbackPath?: string;
}): Promise<LoopbackServer> {
  const callbackPath = opts.callbackPath ?? CALLBACK_PATH;

  let settled = false;
  let settleResolve!: (value: { code: string }) => void;
  let settleReject!: (error: Error) => void;
  const settlePromise = new Promise<{ code: string }>((resolve, reject) => {
    settleResolve = resolve;
    settleReject = reject;
  });
  // A callback can settle (reject) before/without waitForCallback being
  // awaited — keep the bare promise from surfacing an unhandled rejection.
  settlePromise.catch(() => {});

  const handler: Parameters<typeof createServer>[1] = (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname !== callbackPath) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    // First settled answer wins; later requests are stale.
    if (settled) {
      res.writeHead(410, { "content-type": "text/plain; charset=utf-8" });
      res.end("This callback was already handled — return to your terminal.");
      return;
    }
    settled = true;

    const respond = (status: number, html: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    };

    const error = url.searchParams.get("error");
    if (error !== null) {
      respond(200, DENIED_HTML);
      const detail = url.searchParams.get("error_description") ?? error;
      settleReject(
        error === "access_denied"
          ? new LoopbackError(
              "consent_denied",
              "authorization was denied in PostHog",
              detail,
            )
          : new LoopbackError(
              "oauth_error",
              `the OAuth callback returned an error: ${error}`,
              detail,
            ),
      );
      return;
    }

    const state = url.searchParams.get("state");
    if (state === null || state !== opts.state) {
      respond(400, MISMATCH_HTML);
      // High-entropy random state ⇒ plain `===` comparison is fine.
      settleReject(
        new LoopbackError(
          "state_mismatch",
          "state mismatch on the OAuth callback — possible CSRF; retry " +
            "the command",
        ),
      );
      return;
    }

    const code = url.searchParams.get("code");
    if (code === null || code === "") {
      respond(400, NO_CODE_HTML);
      settleReject(
        new LoopbackError(
          "oauth_error",
          "the OAuth callback carried no authorization code",
        ),
      );
      return;
    }

    respond(200, SUCCESS_HTML);
    settleResolve({ code });
  };

  let server: Server | null = null;
  for (const port of opts.ports) {
    server = await tryListen(port, handler);
    if (server) break;
  }
  if (!server) {
    throw new LoopbackError(
      "ports_busy",
      `ports ${opts.ports.join(", ")} on 127.0.0.1 are all in use`,
    );
  }

  const address = server.address();
  const port =
    address !== null && typeof address === "object" ? address.port : 0;
  const bound = server;

  return {
    port,
    redirectUri: `http://127.0.0.1:${port}${callbackPath}`,

    waitForCallback(waitOpts?: { timeoutMs?: number }) {
      const timeoutMs = waitOpts?.timeoutMs ?? CALLBACK_TIMEOUT_MS;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new LoopbackError(
              "timeout",
              "timed out waiting for the OAuth callback (5 minutes)",
            ),
          );
        }, timeoutMs);
      });
      return Promise.race([settlePromise, timeout]).finally(() => {
        clearTimeout(timer);
      });
    },

    close() {
      return new Promise<void>((resolve) => {
        // Keep-alive sockets would hold close() open indefinitely.
        bound.closeAllConnections();
        bound.close(() => resolve());
      });
    },
  };
}
