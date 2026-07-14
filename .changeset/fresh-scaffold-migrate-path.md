---
"@hogsend/db": minor
---

fix: the engine migration track now resolves its bundled `drizzle/` folder with `fileURLToPath` instead of `URL.pathname`. `.pathname` percent-encodes spaces (and other special characters) in the install path, so any app living under a path like `~/My Projects/app` failed the folder-exists check and SILENTLY SKIPPED every engine migration — the DB stayed empty while bootstrap kept going, so the api-key mint (`relation "api_keys" does not exist`), Studio admin create (`relation "user"`), and the `pnpm dev` schema boot guard all failed downstream. A missing bundled-migrations folder is now a loud error instead of a silent skip, and `db:stamp` gets the same path fix.
