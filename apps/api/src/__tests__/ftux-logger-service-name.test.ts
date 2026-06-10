import { createLogger } from "@hogsend/engine";
import { afterEach, describe, expect, it } from "vitest";

// Workstream F (first-run papercuts): scaffolded apps used to log
// `"service":"growthhog-api"` — the engine default is now neutral ("hogsend")
// and overridable per-deploy via SERVICE_NAME.
describe("createLogger service name default", () => {
  const original = process.env.SERVICE_NAME;

  afterEach(() => {
    if (original === undefined) delete process.env.SERVICE_NAME;
    else process.env.SERVICE_NAME = original;
  });

  it("defaults the service label to 'hogsend'", () => {
    delete process.env.SERVICE_NAME;
    const logger = createLogger("info");
    expect(logger.defaultMeta).toEqual({ service: "hogsend" });
  });

  it("respects SERVICE_NAME when set", () => {
    process.env.SERVICE_NAME = "growthhog-api";
    const logger = createLogger("info");
    expect(logger.defaultMeta).toEqual({ service: "growthhog-api" });
  });
});
