---
"create-hogsend": minor
---

Scaffolded apps now run `node dist/index.js` and `node dist/worker.js` on
Railway, not `pnpm start` and `pnpm worker`, and migrate with
`tsx scripts/migrate.ts` rather than `pnpm db:migrate`.

Running pnpm at runtime triggers corepack and a deps-status check that writes
to `/app`, which the production image owns as root and runs as the
unprivileged `node` user. That is an EACCES crash-loop on first boot. The
template was corrected in the repo but never published, so every app scaffolded
since carried the broken commands.

`pnpm preflight` asserts these strings equal the run-mode commands it boots, so
the gate always tests exactly what deploys. Cloud publish enforces the same
check and refuses an image whose deploy config has drifted.
