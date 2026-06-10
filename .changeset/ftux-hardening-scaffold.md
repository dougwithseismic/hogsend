---
"create-hogsend": minor
---

Scaffold first-run polish: `dev`/`worker:dev` watch `src/**` explicitly so newly added journeys restart the worker; ships a `hatchet.yaml` for the `hatchet worker dev` path; migration output no longer leaks raw Postgres NOTICE objects; the post-setup summary prints once; template database credentials are neutral `hogsend` (not `growthhog`); env.example documents the first-boot ingest-key mint.
