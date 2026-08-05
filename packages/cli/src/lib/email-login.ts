import type { CloudClient } from "./cloud-http.js";
import { CloudError } from "./cloud-http.js";

/**
 * The testable half of `hogsend signup` and `hogsend login --email`: mail a
 * code, read it back, and turn it into a session.
 *
 * ONE flow serves both commands because the SERVER makes no distinction — the
 * same two endpoints create a user who has never been seen and log in one who
 * has, and which of those happened is reported in the answer rather than
 * chosen by the caller. Two flows would have to agree about that, and would
 * eventually not.
 *
 * Every side effect — HTTP, the printing, and how the code is obtained — is
 * injected, exactly as in `device-login.ts`, so the whole verdict space (a
 * refused send, a rate limit, a wrong code, a burned code, an expired one, a
 * region with no capacity) is exercised with no network and no terminal.
 *
 * TOKEN HYGIENE INVARIANT: the minted token is RETURNED, never printed. No
 * `emit` call in this file receives it, and no error message carries it.
 *
 * ENUMERATION INVARIANT, inherited: the cloud answers identically for a
 * registered and an unknown address, so this file must not "helpfully" say
 * which one it thinks is happening before the code comes back. The only place
 * the difference is spoken is AFTER verification, from `created` — which the
 * human has by then proven they are entitled to know.
 */

/** `POST /api/cli/signup`. */
export interface SignupSendResponse {
  status: "sent";
  expiresInSeconds: number;
}

/** `POST /api/cli/signup/verify`. */
export interface SignupVerifyResponse {
  status: "ok";
  created: { user: boolean; organization: boolean };
  /** The ONLY copy of the session token that will ever exist here. */
  token: string;
  sessionId: string;
  userId: string;
  organizationId: string;
  environmentId: string | null;
  note: "org_ignored_existing" | null;
}

export type EmailLoginFailure =
  | "invalid_email"
  | "send_failed"
  | "rate_limited"
  | "invalid_code"
  | "code_expired"
  | "code_burned"
  | "no_region"
  | "verify_failed";

export class EmailLoginError extends Error {
  readonly verdict: EmailLoginFailure;
  readonly hint: string | undefined;
  /** Seconds from `retry-after`, when the cloud asked us to wait. */
  readonly retryAfter: number | undefined;

  constructor(
    verdict: EmailLoginFailure,
    message: string,
    extra: { hint?: string; retryAfter?: number } = {},
  ) {
    super(message);
    this.name = "EmailLoginError";
    this.verdict = verdict;
    this.hint = extra.hint;
    this.retryAfter = extra.retryAfter;
  }
}

export interface EmailLoginDeps {
  client: CloudClient;
  /** Human-facing output. NEVER receives the token. */
  emit(line: string): void;
  /**
   * How the code is obtained: a clack prompt when there is a human, one line
   * of stdin when there is not, a canned value in a test. `attempt` is
   * zero-based, so a re-prompt can say "that one was wrong".
   */
  readCode(attempt: number): Promise<string>;
}

export interface EmailLoginOptions {
  email: string;
  /** Organization NAME, honoured by the cloud only for a user with none. */
  org?: string;
  /** The machine name sent as the session label. */
  label: string;
  /**
   * How many codes the human may type before the flow gives up. ONE for a
   * non-interactive run (there is nobody to re-prompt); more when there is a
   * terminal, bounded well under the server's own budget so the CLI never
   * spends the last attempt and burns the code on somebody's behalf.
   */
  maxAttempts?: number;
}

export interface EmailLoginResult extends SignupVerifyResponse {
  /** What the cloud said the code's lifetime was, for the caller to print. */
  expiresInSeconds: number;
}

/**
 * The default attempt budget for an interactive run.
 *
 * The server burns a code after three wrong tries. Two is deliberately less:
 * a human who has mistyped twice is reading the wrong email, and a third
 * automatic prompt would spend the budget that a DELIBERATE re-run needs.
 */
export const DEFAULT_INTERACTIVE_ATTEMPTS = 2;

/** Map a refusal from either endpoint onto our vocabulary. */
function verifyFailure(error: CloudError): EmailLoginError {
  if (error.status === 429) {
    return new EmailLoginError("rate_limited", error.message, {
      hint: error.retryAfter
        ? `Retry in about ${error.retryAfter}s.`
        : "Retry shortly.",
      ...(error.retryAfter === undefined
        ? {}
        : { retryAfter: error.retryAfter }),
    });
  }
  if (error.code === "code_expired") {
    return new EmailLoginError("code_expired", error.message, {
      hint: "That code has a ten-minute life. Run the command again for a fresh one.",
    });
  }
  if (error.code === "code_burned") {
    return new EmailLoginError("code_burned", error.message, {
      hint: "Run the command again for a fresh code.",
    });
  }
  if (error.code === "invalid_code") {
    return new EmailLoginError("invalid_code", error.message, {
      hint: "Check the code in your inbox and try again.",
    });
  }
  if (error.code === "no_region") {
    return new EmailLoginError("no_region", error.message, {
      hint: "Nothing was created, and your account is fine. Contact support@hogsend.com and we will place you.",
    });
  }
  return new EmailLoginError("verify_failed", error.message);
}

/**
 * Send the code, collect it, exchange it for a session.
 *
 * A wrong code is RETRIED in place while the budget allows, because the
 * alternative — exiting and making the human re-run the command — would send
 * a second code and leave the first one live. Every other refusal is terminal:
 * an expired or burned code cannot be fixed by typing it again.
 */
export async function runEmailLogin(
  options: EmailLoginOptions,
  deps: EmailLoginDeps,
): Promise<EmailLoginResult> {
  let sent: SignupSendResponse;
  try {
    sent = await deps.client.post<SignupSendResponse>("/api/cli/signup", {
      email: options.email,
    });
  } catch (error) {
    if (!(error instanceof CloudError)) throw error;
    if (error.status === 429) throw verifyFailure(error);
    if (error.code === "invalid_email") {
      throw new EmailLoginError("invalid_email", error.message, {
        hint: "Check the address and try again.",
      });
    }
    // Everything else — a 502 from the mail transport, an unreachable host —
    // is the same thing to the caller: no code is coming, so there is nothing
    // to wait for and nothing to type.
    throw new EmailLoginError(
      "send_failed",
      `Could not send a code from ${deps.client.baseUrl}: ${error.message}`,
      {
        hint:
          error.status === 0
            ? "Check the URL and your network, then try again."
            : "Try again shortly.",
      },
    );
  }

  const attempts = Math.max(1, options.maxAttempts ?? 1);
  let lastInvalid: EmailLoginError | undefined;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const otp = (await deps.readCode(attempt)).trim();

    try {
      const verified = await deps.client.post<SignupVerifyResponse>(
        "/api/cli/signup/verify",
        {
          email: options.email,
          otp,
          label: options.label,
          ...(options.org === undefined ? {} : { org: options.org }),
        },
      );
      return { ...verified, expiresInSeconds: sent.expiresInSeconds };
    } catch (error) {
      if (!(error instanceof CloudError)) throw error;
      const failure = verifyFailure(error);
      // Only a wrong code is worth another go: it is the one refusal the
      // human can fix with the code they already have.
      if (failure.verdict !== "invalid_code") throw failure;
      lastInvalid = failure;
      if (attempt < attempts - 1) deps.emit(`  ${failure.message}`);
    }
  }

  throw (
    lastInvalid ??
    new EmailLoginError("invalid_code", "That code is not right.")
  );
}
