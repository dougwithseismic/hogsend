import { describe, expect, it } from "vitest";
import {
  KEY_VALIDATION_TIMEOUT_MS,
  validateProviderKey,
} from "../services/key-validation";

/**
 * The validators, with a FAKE fetch. Nothing in this file may touch the
 * network: a suite that hit api.resend.com would be red whenever a vendor is,
 * and would need real credentials to be green — which is exactly the thing a
 * control plane must never keep in its repo.
 *
 * Every credential below is an obvious fake.
 */

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

/** A fetch that answers with a scripted response and records what it was asked. */
function fakeFetch(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
): { impl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    requests.push({ url: String(input), init });
    return respond(String(input), init);
  }) as typeof fetch;
  return { impl, requests };
}

/** A fetch that fails the way a DNS failure or a timeout does. */
const unreachableFetch = (async () => {
  throw new TypeError("fetch failed");
}) as typeof fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("validateProviderKey: resend", () => {
  it("accepts a live key and reports ONLY the verified domains", async () => {
    const { impl, requests } = fakeFetch(() =>
      json({
        data: [
          { name: "acme.test", status: "verified" },
          { name: "pending.test", status: "pending" },
          { name: "failed.test", status: "failed" },
        ],
      }),
    );

    const result = await validateProviderKey({
      provider: "resend",
      payload: { apiKey: "re_fake_key_1111" },
      fetchImpl: impl,
    });

    expect(result.valid).toBe(true);
    expect(result.detail).toBe("ok");
    // A pending domain is NOT a sending identity — accepting one would let a
    // tenant configure a from-address their provider will refuse.
    expect(result.verifiedDomains).toEqual(["acme.test"]);

    const request = requests[0];
    expect(request?.url).toBe("https://api.resend.com/domains");
    expect(new Headers(request?.init.headers).get("authorization")).toBe(
      "Bearer re_fake_key_1111",
    );
    // Fail-fast rather than hang a form submit on a vendor outage.
    expect(request?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a key the provider refuses", async () => {
    const { impl } = fakeFetch(() => json({ message: "invalid" }, 401));

    expect(
      await validateProviderKey({
        provider: "resend",
        payload: { apiKey: "re_fake_bad" },
        fetchImpl: impl,
      }),
    ).toEqual({ valid: false, detail: "unauthorized" });
  });

  it("fails CLOSED when the provider is unreachable", async () => {
    expect(
      await validateProviderKey({
        provider: "resend",
        payload: { apiKey: "re_fake_key_1111" },
        fetchImpl: unreachableFetch,
      }),
    ).toEqual({ valid: false, detail: "unreachable" });
  });

  it("rejects a payload with no key before making a request", async () => {
    const { impl, requests } = fakeFetch(() => json({}));

    const result = await validateProviderKey({
      provider: "resend",
      payload: { fromEmail: "hello@acme.test" },
      fetchImpl: impl,
    });

    expect(result).toEqual({ valid: false, detail: "missing_field:apiKey" });
    expect(requests).toHaveLength(0);
  });
});

describe("validateProviderKey: postmark", () => {
  it("accepts a live server token", async () => {
    const { impl, requests } = fakeFetch(() => json({ ID: 1, Name: "acme" }));

    const result = await validateProviderKey({
      provider: "postmark",
      payload: { serverToken: "pm_fake_token_2222" },
      fetchImpl: impl,
    });

    expect(result).toEqual({ valid: true, detail: "ok" });
    expect(requests[0]?.url).toBe("https://api.postmarkapp.com/server");
    expect(
      new Headers(requests[0]?.init.headers).get("x-postmark-server-token"),
    ).toBe("pm_fake_token_2222");
  });

  it("rejects a refused token and an unreachable provider", async () => {
    const { impl } = fakeFetch(() => json({ ErrorCode: 10 }, 401));
    expect(
      await validateProviderKey({
        provider: "postmark",
        payload: { serverToken: "pm_fake_bad" },
        fetchImpl: impl,
      }),
    ).toEqual({ valid: false, detail: "unauthorized" });

    expect(
      await validateProviderKey({
        provider: "postmark",
        payload: { serverToken: "pm_fake_token_2222" },
        fetchImpl: unreachableFetch,
      }),
    ).toEqual({ valid: false, detail: "unreachable" });
  });
});

describe("validateProviderKey: posthog", () => {
  it("live-probes the PERSONAL key and accepts on 200", async () => {
    const { impl, requests } = fakeFetch(() => json({ results: [] }));

    const result = await validateProviderKey({
      provider: "posthog",
      payload: {
        apiKey: "phc_fakefakefakefakefake1111",
        personalApiKey: "phx_fake_personal_3333",
        host: "https://eu.posthog.com/",
      },
      fetchImpl: impl,
    });

    expect(result).toEqual({ valid: true, detail: "ok" });
    expect(requests[0]?.url).toBe("https://eu.posthog.com/api/projects/");
    expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe(
      "Bearer phx_fake_personal_3333",
    );
  });

  it("rejects a refused personal key", async () => {
    const { impl } = fakeFetch(() => json({ detail: "nope" }, 401));

    expect(
      await validateProviderKey({
        provider: "posthog",
        payload: {
          apiKey: "phc_fakefakefakefakefake1111",
          personalApiKey: "phx_fake_bad",
        },
        fetchImpl: impl,
      }),
    ).toEqual({ valid: false, detail: "unauthorized" });
  });

  it("validates a project-key-only payload by SHAPE, with no request", async () => {
    // Documented choice: the phc_ project key is write-only by PostHog's
    // design, and every probe for it would persist an event. Shape is the only
    // honest offline answer, and the detail says so rather than claiming "ok".
    const { impl, requests } = fakeFetch(() => json({}));

    expect(
      await validateProviderKey({
        provider: "posthog",
        payload: { apiKey: "phc_fakefakefakefakefake1111" },
        fetchImpl: impl,
      }),
    ).toEqual({ valid: true, detail: "shape_only" });
    expect(requests).toHaveLength(0);

    expect(
      await validateProviderKey({
        provider: "posthog",
        payload: { apiKey: "not-a-posthog-key" },
        fetchImpl: impl,
      }),
    ).toEqual({ valid: false, detail: "malformed_key" });
  });
});

describe("validateProviderKey: twilio", () => {
  it("fetches the account with basic auth and accepts on 200", async () => {
    const { impl, requests } = fakeFetch(() => json({ status: "active" }));

    const result = await validateProviderKey({
      provider: "twilio",
      payload: {
        accountSid: "ACfakefakefake4444",
        authToken: "fake_twilio_token_4444",
      },
      fetchImpl: impl,
    });

    expect(result).toEqual({ valid: true, detail: "ok" });
    expect(requests[0]?.url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/ACfakefakefake4444.json",
    );
    expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("ACfakefakefake4444:fake_twilio_token_4444").toString("base64")}`,
    );
  });

  it("rejects a refused credential, a missing sid, and an outage", async () => {
    const { impl } = fakeFetch(() => json({ code: 20003 }, 401));
    expect(
      await validateProviderKey({
        provider: "twilio",
        payload: { accountSid: "ACfake", authToken: "bad" },
        fetchImpl: impl,
      }),
    ).toEqual({ valid: false, detail: "unauthorized" });

    expect(
      await validateProviderKey({
        provider: "twilio",
        payload: { authToken: "fake_twilio_token_4444" },
        fetchImpl: impl,
      }),
    ).toEqual({ valid: false, detail: "missing_field:accountSid" });

    expect(
      await validateProviderKey({
        provider: "twilio",
        payload: { accountSid: "ACfake", authToken: "fake" },
        fetchImpl: unreachableFetch,
      }),
    ).toEqual({ valid: false, detail: "unreachable" });
  });
});

describe("validateProviderKey: unknown providers and server faults", () => {
  it("refuses a provider it cannot prove", async () => {
    const { impl, requests } = fakeFetch(() => json({}));

    expect(
      await validateProviderKey({
        provider: "mailchimp",
        payload: { apiKey: "fake" },
        fetchImpl: impl,
      }),
    ).toEqual({ valid: false, detail: "unsupported_provider" });
    expect(requests).toHaveLength(0);
  });

  it("reports a provider-side fault as its status, not as success", async () => {
    const { impl } = fakeFetch(() => json({ error: "boom" }, 503));

    expect(
      await validateProviderKey({
        provider: "resend",
        payload: { apiKey: "re_fake_key_1111" },
        fetchImpl: impl,
      }),
    ).toEqual({ valid: false, detail: "http_503" });
  });

  it("keeps the timeout short enough for a form submit", () => {
    expect(KEY_VALIDATION_TIMEOUT_MS).toBe(5000);
  });
});
