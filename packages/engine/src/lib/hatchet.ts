import { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import { env } from "../env.js";

// Construct the Hatchet client from our validated env contract so host/port and
// TLS strategy are honoured from a single source of truth, rather than relying on
// the SDK's independent process.env read. The SDK would read the same vars on its
// own, but passing them explicitly keeps env.ts authoritative and makes the
// connection config debuggable.
//
// `tls_config.tls_strategy` defaults to `tls` (secure); the local insecure
// hatchet-lite path sets HATCHET_CLIENT_TLS_STRATEGY=none. `namespace` is the
// future per-tenant knob (default-empty today).
export const hatchet = HatchetClient.init({
  token: env.HATCHET_CLIENT_TOKEN,
  host_port: env.HATCHET_CLIENT_HOST_PORT,
  tls_config: { tls_strategy: env.HATCHET_CLIENT_TLS_STRATEGY },
  ...(env.HATCHET_CLIENT_NAMESPACE
    ? { namespace: env.HATCHET_CLIENT_NAMESPACE }
    : {}),
});
