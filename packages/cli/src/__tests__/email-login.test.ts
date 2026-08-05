import { describe, expect, it } from "vitest";
import { createCloudClient, type FetchLike } from "../lib/cloud-http.js";
import {
  type EmailLoginDeps,
  EmailLoginError,
  runEmailLogin,
} from "../lib/email-login.js";

/**
 * The emailed-code flow against a SCRIPTED cloud: no network, no terminal, no
 * inbox. Every side effect is injected — the HTTP client, the printing, and
 * how the code is obtained — so the whole verdict space is exercised in
 * milliseconds.
 *
 * Two invariants outrank the rest, and every case checks them:
 *  - NOTHING printed by this flow contains the token;
 *  - a wrong code costs ONE code, not two. Re-prompting in place is the whole
 *    reason the retry lives here rather than in "run the command again", and
 *    a second `/api/cli/signup` would mail a second code and leave the first
 *    live.
 */

const BASE_URL = "https://cloud.hogsend.test";
const TOKEN = "hscli_minted_secret_never_printed";
const EMAIL = "someone@acme.test";

interface Scripted {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A fetch that answers each path from a queue, and records what was asked. */
function scriptedFetch(script: Record<string, Scripted[]>): {
  fetchImpl: FetchLike;
  calls: { path: string; body: unknown }[];
} {
  const calls: { path: string; body: unknown }[] = [];
  const remaining: Record<string, Scripted[]> = {};
  for (const [path, answers] of Object.entries(script)) {
    remaining[path] = [...answers];
  }

  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const raw = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ path, body: raw ? JSON.parse(raw) : undefined });

    const queue = remaining[path];
    if (!queue || queue.length === 0) {
      throw new Error(`unscripted request: ${path}`);
    }
    // The LAST answer repeats, so a steady-state tail needs no padding.
    const answer = (queue.length > 1 ? queue.shift() : queue[0]) as Scripted;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json", ...answer.headers },
    });
  };

  return { fetchImpl, calls };
}

const SENT: Scripted = {
  status: 200,
  body: { status: "sent", expiresInSeconds: 600 },
};

const VERIFIED: Scripted = {
  status: 200,
  body: {
    status: "ok",
    created: { user: true, organization: true },
    token: TOKEN,
    sessionId: "session-1",
    userId: "user-1",
    organizationId: "org-1",
    environmentId: "env-1",
    note: null,
  },
};

/** A refusal in the cloud's `{ error, message }` envelope. */
function refusal(
  status: number,
  error: string,
  message: string,
  headers?: Record<string, string>,
): Scripted {
  return {
    status,
    body: { error, message },
    ...(headers === undefined ? {} : { headers }),
  };
}

function harness(script: Record<string, Scripted[]>, codes: string[] = []) {
  const { fetchImpl, calls } = scriptedFetch(script);
  const lines: string[] = [];
  const asked: number[] = [];

  const deps: EmailLoginDeps = {
    client: createCloudClient({ baseUrl: BASE_URL, fetchImpl }),
    emit: (line) => lines.push(line),
    readCode: async (attempt) => {
      asked.push(attempt);
      return codes[attempt] ?? "000000";
    },
  };

  return { deps, lines, calls, asked };
}

describe("runEmailLogin", () => {
  it("sends a code, exchanges it, and returns the token without printing it", async () => {
    const { deps, lines, calls } = harness(
      {
        "/api/cli/signup": [SENT],
        "/api/cli/signup/verify": [VERIFIED],
      },
      ["123456"],
    );

    const result = await runEmailLogin(
      { email: EMAIL, label: "laptop", org: "Acme Rockets" },
      deps,
    );

    expect(result.token).toBe(TOKEN);
    expect(result.created).toEqual({ user: true, organization: true });
    expect(result.environmentId).toBe("env-1");
    expect(result.expiresInSeconds).toBe(600);

    // The send leg carries the address and NOTHING else — no org, no label:
    // it exists only to prove the inbox, and a field it does not need is a
    // field an unauthenticated caller could abuse.
    expect(calls[0]).toEqual({
      path: "/api/cli/signup",
      body: { email: EMAIL },
    });
    expect(calls[1]).toEqual({
      path: "/api/cli/signup/verify",
      body: {
        email: EMAIL,
        otp: "123456",
        label: "laptop",
        org: "Acme Rockets",
      },
    });

    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("omits `org` entirely when none was given", async () => {
    const { deps, calls } = harness(
      { "/api/cli/signup": [SENT], "/api/cli/signup/verify": [VERIFIED] },
      ["123456"],
    );

    await runEmailLogin({ email: EMAIL, label: "laptop" }, deps);

    // Absent, not empty-string: the cloud treats a blank name as a name.
    expect(calls[1]?.body).toEqual({
      email: EMAIL,
      otp: "123456",
      label: "laptop",
    });
  });

  it("re-prompts on a wrong code, spending ONE code rather than two", async () => {
    const { deps, calls, asked, lines } = harness(
      {
        "/api/cli/signup": [SENT],
        "/api/cli/signup/verify": [
          refusal(401, "invalid_code", "That code is not right."),
          VERIFIED,
        ],
      },
      ["000001", "123456"],
    );

    const result = await runEmailLogin(
      { email: EMAIL, label: "laptop", maxAttempts: 2 },
      deps,
    );

    expect(result.token).toBe(TOKEN);
    // Asked twice, and the attempt index is passed so the prompt can change.
    expect(asked).toEqual([0, 1]);
    // ONE send. A flow that started over would mail a second code and leave
    // the first one live for its full ten minutes.
    expect(calls.filter((c) => c.path === "/api/cli/signup")).toHaveLength(1);
    expect(lines.join("\n")).toContain("That code is not right.");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("gives up after the budget and reports the wrong code", async () => {
    const { deps, asked } = harness(
      {
        "/api/cli/signup": [SENT],
        "/api/cli/signup/verify": [
          refusal(401, "invalid_code", "That code is not right."),
        ],
      },
      ["1", "2"],
    );

    const error = await runEmailLogin(
      { email: EMAIL, label: "laptop", maxAttempts: 2 },
      deps,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EmailLoginError);
    expect((error as EmailLoginError).verdict).toBe("invalid_code");
    expect(asked).toEqual([0, 1]);
  });

  it("asks ONCE when there is nobody to re-prompt", async () => {
    // The piped/`--json` case: stdin has one line, and reading it again would
    // block forever.
    const { deps, asked } = harness(
      {
        "/api/cli/signup": [SENT],
        "/api/cli/signup/verify": [
          refusal(401, "invalid_code", "That code is not right."),
        ],
      },
      ["000001"],
    );

    await runEmailLogin({ email: EMAIL, label: "ci" }, deps).catch(() => {});
    expect(asked).toEqual([0]);
  });

  it("never retries a code that is dead", async () => {
    for (const [code, verdict] of [
      ["code_burned", "code_burned"],
      ["code_expired", "code_expired"],
    ] as const) {
      const { deps, asked } = harness(
        {
          "/api/cli/signup": [SENT],
          "/api/cli/signup/verify": [refusal(401, code, "Dead code.")],
        },
        ["1", "2"],
      );

      const error = await runEmailLogin(
        { email: EMAIL, label: "laptop", maxAttempts: 3 },
        deps,
      ).catch((e: unknown) => e);

      expect((error as EmailLoginError).verdict).toBe(verdict);
      // Retyping a burned or expired code cannot help, so the human is told
      // once rather than made to type it three times.
      expect(asked).toEqual([0]);
      expect((error as EmailLoginError).hint).toContain("again");
    }
  });

  it("carries the retry-after through a rate limit on the send", async () => {
    const { deps, asked } = harness({
      "/api/cli/signup": [
        refusal(429, "rate_limited", "Too many codes requested.", {
          "retry-after": "42",
        }),
      ],
    });

    const error = await runEmailLogin({ email: EMAIL, label: "l" }, deps).catch(
      (e: unknown) => e,
    );

    expect((error as EmailLoginError).verdict).toBe("rate_limited");
    expect((error as EmailLoginError).retryAfter).toBe(42);
    expect((error as EmailLoginError).hint).toContain("42s");
    // Nothing was mailed, so nothing was asked for.
    expect(asked).toEqual([]);
  });

  it("refuses a bad address and a broken transport distinctly", async () => {
    const bad = harness({
      "/api/cli/signup": [
        refusal(400, "invalid_email", "That is not an email address."),
      ],
    });
    const badError = await runEmailLogin(
      { email: "nope", label: "l" },
      bad.deps,
    ).catch((e: unknown) => e);
    expect((badError as EmailLoginError).verdict).toBe("invalid_email");

    const broken = harness({
      "/api/cli/signup": [
        refusal(502, "send_failed", "The code could not be sent."),
      ],
    });
    const brokenError = await runEmailLogin(
      { email: EMAIL, label: "l" },
      broken.deps,
    ).catch((e: unknown) => e);
    expect((brokenError as EmailLoginError).verdict).toBe("send_failed");
    // Both stop before the prompt: there is no code coming to type.
    expect(bad.asked).toEqual([]);
    expect(broken.asked).toEqual([]);
  });

  it("names a region with no capacity as its own verdict", async () => {
    const { deps } = harness(
      {
        "/api/cli/signup": [SENT],
        "/api/cli/signup/verify": [
          refusal(503, "no_region", "No capacity is available in that region."),
        ],
      },
      ["123456"],
    );

    const error = await runEmailLogin(
      { email: EMAIL, label: "l", maxAttempts: 3 },
      deps,
    ).catch((e: unknown) => e);

    expect((error as EmailLoginError).verdict).toBe("no_region");
    // The code was correct — retyping it would be cruel and would burn it.
    expect((error as EmailLoginError).hint).toContain("Nothing was created");
  });

  it("reports a returning user as a login, not a signup", async () => {
    const { deps } = harness(
      {
        "/api/cli/signup": [SENT],
        "/api/cli/signup/verify": [
          {
            status: 200,
            body: {
              ...(VERIFIED.body as Record<string, unknown>),
              created: { user: false, organization: false },
              note: "org_ignored_existing",
            },
          },
        ],
      },
      ["123456"],
    );

    const result = await runEmailLogin(
      { email: EMAIL, label: "l", org: "A Second Company" },
      deps,
    );

    // The flow does not decide this — the cloud does, and the flow passes it
    // through so exactly one place knows the answer.
    expect(result.created).toEqual({ user: false, organization: false });
    expect(result.note).toBe("org_ignored_existing");
  });
});
