// Vapi has no first-party Node SDK we depend on — the REST surface we need is a
// single `POST /call`, so we use the Node 22 global `fetch`. Thin wrapper
// mirroring plugin-twilio's `createTwilioClient`.

const DEFAULT_BASE_URL = "https://api.vapi.ai";

export interface VapiClient {
  /** POST /call — create an outbound call. Returns the parsed JSON body. */
  createCall(body: unknown): Promise<VapiCallResponse>;
}

/** The subset of Vapi's create-call response the provider reads. */
export interface VapiCallResponse {
  id: string;
  status?: string;
  [key: string]: unknown;
}

/**
 * Construct a Vapi REST client bound to a private API key. `baseUrl` is
 * overridable for tests / self-hosted proxies.
 */
export function createVapiClient(config: {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): VapiClient {
  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = config.fetchImpl ?? fetch;

  return {
    async createCall(body: unknown): Promise<VapiCallResponse> {
      const res = await doFetch(`${base}/call`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        // Surface the status + body so the caller can classify retryable vs not.
        const err = new Error(
          `Vapi create-call failed (${res.status}): ${text.slice(0, 500)}`,
        ) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return (text ? JSON.parse(text) : {}) as VapiCallResponse;
    },
  };
}
