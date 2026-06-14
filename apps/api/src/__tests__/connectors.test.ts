import {
  type ConnectorCtx,
  ConnectorRegistry,
  createApp,
  createHogsendClient,
  type DefinedConnector,
  type DefinedWebhookSource,
  defineConnector,
  defineWebhookSource,
  type InboundVerifyAuth,
  type IngestEvent,
  type WebhookSourceAuth,
  type WebhookSourceCtx,
  webhookSourceToConnector,
} from "@hogsend/engine";
import { describe, expect, expectTypeOf, it } from "vitest";

const noopCtx: ConnectorCtx = {
  db: {} as never,
  logger: {} as never,
  transport: "webhook",
};

describe("defineConnector", () => {
  it("returns the connector definition unchanged", () => {
    const connector = defineConnector({
      meta: { id: "unit-webhook", name: "Unit", transport: "webhook" },
      inboundVerify: { type: "match", header: "x-secret", envKey: "X_SECRET" },
      async transform(payload: { foo: string }) {
        return {
          event: payload.foo,
          userId: "u1",
          eventProperties: {},
        };
      },
    });

    expect(connector.meta.id).toBe("unit-webhook");
    expect(connector.meta.transport).toBe("webhook");
    expect(connector.inboundVerify?.type).toBe("match");
    expect(connector.transform).toBeTypeOf("function");
  });

  it("throws when a webhook connector omits inboundVerify", () => {
    expect(() =>
      defineConnector({
        meta: { id: "bad-webhook", name: "Bad", transport: "webhook" },
        async transform() {
          return null;
        },
      }),
    ).toThrow(/must declare inboundVerify/);
  });

  it("throws when a gateway connector declares inboundVerify", () => {
    expect(() =>
      defineConnector({
        meta: { id: "bad-gateway", name: "Bad", transport: "gateway" },
        // The type permits inboundVerify on any transport (it is optional on
        // DefinedConnector); the transport-shaped pairing is enforced at runtime
        // by the defineConnector guard, which this asserts.
        inboundVerify: { type: "match", header: "x", envKey: "X" },
        async transform() {
          return null;
        },
      }),
    ).toThrow(/must not declare inboundVerify/);
  });

  it("defaults a connector with no transport to webhook (requires inboundVerify)", () => {
    expect(() =>
      defineConnector({
        meta: { id: "no-transport", name: "NoTransport" },
        async transform() {
          return null;
        },
      }),
    ).toThrow(/transport=webhook/);
  });
});

describe("ConnectorRegistry", () => {
  it("registers and resolves by id", () => {
    const a = defineConnector({
      meta: { id: "a", name: "A", transport: "webhook" },
      inboundVerify: { type: "match", header: "h", envKey: "K" },
      async transform() {
        return null;
      },
    });
    const registry = new ConnectorRegistry([a]);

    expect(registry.count()).toBe(1);
    expect(registry.get("a")).toBe(a);
    expect(registry.get("missing")).toBeUndefined();
  });

  it("filters by transport", () => {
    const webhook = defineConnector({
      meta: { id: "wh", name: "WH", transport: "webhook" },
      inboundVerify: { type: "match", header: "h", envKey: "K" },
      async transform() {
        return null;
      },
    });
    const gateway = defineConnector({
      meta: { id: "gw", name: "GW", transport: "gateway" },
      credential: { kind: "derived" },
      async transform() {
        return null;
      },
    });
    const registry = new ConnectorRegistry([webhook, gateway]);

    expect(registry.getByTransport("webhook")).toEqual([webhook]);
    expect(registry.getByTransport("gateway")).toEqual([gateway]);
    expect(registry.getByTransport("poll")).toEqual([]);
  });

  it("treats an undefined transport as webhook for getByTransport", () => {
    // A connector defined with no explicit transport defaults to "webhook"
    // (so it MUST carry inboundVerify). It must surface under
    // getByTransport("webhook") and never under gateway/poll.
    const c = defineConnector({
      meta: { id: "implicit", name: "Implicit" },
      inboundVerify: { type: "match", header: "h", envKey: "K" },
      async transform() {
        return null;
      },
    });
    const registry = new ConnectorRegistry([c]);
    expect(registry.getByTransport("webhook")).toEqual([c]);
    expect(registry.getByTransport("gateway")).toEqual([]);
  });

  it("register() overwrites last-writer-wins, unregister() removes", () => {
    const v1 = defineConnector({
      meta: { id: "dup", name: "V1", transport: "webhook" },
      inboundVerify: { type: "match", header: "h", envKey: "K" },
      async transform() {
        return null;
      },
    });
    const v2 = defineConnector({
      meta: { id: "dup", name: "V2", transport: "webhook" },
      inboundVerify: { type: "match", header: "h", envKey: "K" },
      async transform() {
        return null;
      },
    });
    const registry = new ConnectorRegistry([v1]);
    registry.register(v2);
    expect(registry.get("dup")?.meta.name).toBe("V2");
    expect(registry.count()).toBe(1);

    expect(registry.unregister("dup")).toBe(true);
    expect(registry.get("dup")).toBeUndefined();
    expect(registry.unregister("dup")).toBe(false);
  });
});

describe("webhookSourceToConnector (back-compat alias, no regression)", () => {
  it("lifts a webhook source onto the connector umbrella unchanged", () => {
    const source = defineWebhookSource({
      meta: { id: "legacy", name: "Legacy" },
      auth: { type: "match", header: "x-legacy", envKey: "LEGACY_SECRET" },
      async transform(payload: { foo: string }): Promise<IngestEvent> {
        return {
          event: payload.foo,
          userId: "legacy-user",
          eventProperties: { via: "legacy" },
        };
      },
    });

    const connector = webhookSourceToConnector(source);

    // The lift always stamps transport:"webhook" + maps auth → inboundVerify.
    expect(connector.meta.id).toBe("legacy");
    expect(connector.meta.transport).toBe("webhook");
    expect(connector.inboundVerify).toEqual(source.auth);
  });

  it("the lifted transform still produces the same IngestEvent", async () => {
    const source = defineWebhookSource({
      meta: { id: "legacy-transform", name: "Legacy" },
      auth: { type: "match", header: "x", envKey: "K" },
      async transform(payload: { name: string }): Promise<IngestEvent> {
        return {
          event: payload.name,
          userId: "u-42",
          eventProperties: { src: "webhook" },
          contactProperties: { tier: "pro" },
        };
      },
    });

    const connector = webhookSourceToConnector(source);
    const result = await connector.transform(
      { name: "signup" } as never,
      noopCtx,
    );

    expect(result).toEqual({
      event: "signup",
      userId: "u-42",
      eventProperties: { src: "webhook" },
      contactProperties: { tier: "pro" },
    });
  });

  it("preset webhook sources resolve through the container's connector registry", () => {
    // The container builds the unified registry (the test env sets
    // STRIPE_WEBHOOK_SECRET, so the stripe preset auto-mounts). Every
    // webhook-transport connector MUST be reachable via getByTransport("webhook")
    // and carry inboundVerify, never leaking a gateway connector into the
    // webhook dispatch.
    const container = createHogsendClient();
    const webhookConnectors =
      container.connectorRegistry.getByTransport("webhook");
    for (const connector of webhookConnectors) {
      expect(connector.meta.transport ?? "webhook").toBe("webhook");
      expect(connector.inboundVerify).toBeDefined();
    }
  });
});

describe("webhook route dispatch through the connector registry", () => {
  // Mirror the legacy webhook-sources.test.ts assertions to prove the rewritten
  // dispatch path (now sourced from the connector registry) is a no-regression.
  const source = defineWebhookSource({
    meta: { id: "unitsrc", name: "Unit Source" },
    auth: { type: "match", header: "x-unit", envKey: "UNIT_SECRET" },
    async transform(payload: { event: string }): Promise<IngestEvent> {
      return { event: payload.event, userId: "u1", eventProperties: {} };
    },
  });
  const container = createHogsendClient();
  const app = createApp(container, { webhookSources: [source] });

  it("returns 404 for an unknown webhook source", async () => {
    const res = await app.request("/v1/webhooks/nonexistent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "test" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Unknown webhook source");
  });

  it("the lifted source is reachable via getByTransport on the registry", () => {
    const found = container.connectorRegistry
      .getByTransport("webhook")
      .find((c) => c.meta.id === "unitsrc");
    expect(found).toBeDefined();
    expect(found?.inboundVerify?.type).toBe("match");
  });

  it("does not 404 the generic connector ingress route (registered)", async () => {
    // No gateway connector with this id is registered, so it 404s — but the
    // route itself exists (it self-authenticates, never api-key 401s).
    const res = await app.request("/v1/connectors/unknown/ingress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Unknown gateway connector");
  });
});

describe("WebhookSourceAuth surface pin (frozen alias)", () => {
  it("stays byte-for-byte equal to the connector inbound-verify union", () => {
    // If a future additive change widens InboundVerifyAuth (a third variant for
    // a new transport), this fails the build — pinning the frozen public
    // webhook-source auth shape so the alias can never silently drift.
    expectTypeOf<WebhookSourceAuth>().toEqualTypeOf<InboundVerifyAuth>();
    expectTypeOf<WebhookSourceAuth>().toEqualTypeOf<
      | { type: "match"; header: string; envKey: string }
      | {
          type: "signature";
          scheme: "svix" | "stripe" | "hmac-hex";
          envKey: string;
          header: string;
          fallbackMatchHeader?: string;
          verify?: (args: {
            rawBody: string;
            headers: Record<string, string>;
            secret: string;
          }) => boolean | Promise<boolean>;
        }
    >();
  });

  it("a DefinedConnector is structurally compatible with the registry", () => {
    expectTypeOf<DefinedConnector>().toHaveProperty("meta");
    expectTypeOf<DefinedConnector>().toHaveProperty("transform");
  });
});

describe("preset env-gating is semver-hygienic (enablePresets)", () => {
  // The test env sets STRIPE_WEBHOOK_SECRET, so the `stripe` env preset
  // auto-mounts. Constructing the app/registry needs no DB or HTTP (we only
  // read the registry — `app.request()` is never called).
  const presetId = "stripe";

  it("the default (presets enabled) mounts the env preset", () => {
    const container = createHogsendClient();
    createApp(container);
    const ids = container.connectorRegistry
      .getByTransport("webhook")
      .map((c) => c.meta.id);
    expect(ids).toContain(presetId);
  });

  it("enablePresets:false strips every env-preset id from webhook transport", () => {
    const container = createHogsendClient();
    createApp(container, { enablePresets: false });
    const ids = container.connectorRegistry
      .getByTransport("webhook")
      .map((c) => c.meta.id);
    // No preset id (e.g. stripe) survives the deprecated suppression path.
    expect(ids).not.toContain(presetId);
    expect(ids).not.toContain("clerk");
    expect(ids).not.toContain("supabase");
    expect(ids).not.toContain("segment");
  });
});

describe("webhookSourceToConnector input type accepts an annotated transform", () => {
  it("a DefinedWebhookSource whose transform annotates ctx: WebhookSourceCtx is assignable", () => {
    // A consumer transform that EXPLICITLY annotates its ctx param against the
    // public `WebhookSourceCtx` must still satisfy `webhookSourceToConnector`'s
    // input — i.e. the engine widening `ctx` to `ConnectorCtx` internally never
    // narrows what a consumer source may declare. If a future change broke this
    // assignability, this fails the build (the no-regression DX guarantee).
    type AnnotatedSource = DefinedWebhookSource<{ event: string }>;
    const source: AnnotatedSource = defineWebhookSource({
      meta: { id: "annotated", name: "Annotated" },
      auth: { type: "match", header: "x-a", envKey: "A_SECRET" },
      async transform(
        payload: { event: string },
        _ctx: WebhookSourceCtx,
      ): Promise<IngestEvent> {
        return { event: payload.event, userId: "u", eventProperties: {} };
      },
    });

    // The runtime lift compiles AND the input type is assignable.
    expectTypeOf(source).toMatchTypeOf<
      Parameters<typeof webhookSourceToConnector>[0]
    >();
    const connector = webhookSourceToConnector(source);
    expect(connector.meta.transport).toBe("webhook");
  });
});
