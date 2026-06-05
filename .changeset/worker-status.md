---
"@hogsend/engine": minor
---

Surface worker connectivity. The worker now publishes a TTL'd Redis heartbeat, and `GET /v1/health` reports a `components.worker` status (`up`/`down` + `lastSeenAt`) derived from it — so the API and Studio can tell whether a worker is actually connected, instead of journeys silently not firing when no worker is running. The field is informational and does **not** affect the API's own `status` (the worker is a separate service, so its absence must not fail the API healthcheck). Best-effort: a Redis-less deploy reads `worker.status: "down"` and never crashes the worker.
