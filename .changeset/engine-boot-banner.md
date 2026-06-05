---
"@hogsend/engine": minor
---

Add engine-owned, TTY-aware boot output. On an interactive `pnpm dev` the API and worker now print a minimal branded banner — magenta badge, `engine` + `api` versions, loaded journeys·buckets·templates, schema status, and the API/Docs/Studio/Guides links plus a next-step hint. In production, CI, and tests they instead emit a single structured `… ready` log line, so log scraping is unchanged. The previously-scattered registry/studio/server boot logs drop to `debug`, making the banner the single source of truth on startup.

New public exports: `reportApiReady`, `reportWorkerReady`, `getEngineVersion`. The running engine version is read at runtime from the package manifest (adds a `./package.json` entry to `exports`), falling back to `"unknown"` only if that read ever fails.
