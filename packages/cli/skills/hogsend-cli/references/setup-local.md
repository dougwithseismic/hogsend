# Set up a local Hogsend instance

`hogsend setup` is interactive LOCAL onboarding — it mirrors the "next steps"
that `create-hogsend` prints after scaffolding. It is NOT a Railway / cloud
deploy flow.

## Run it

```bash
hogsend setup
```

What it does (interactively, with clack prompts + spinners):

1. `docker compose up -d` — starts TimescaleDB (Postgres), Redis, and
   Hatchet-Lite locally.
2. Generates a `BETTER_AUTH_SECRET`.
3. Copies `.env.example` to `.env` if `.env` doesn't already exist (it won't
   clobber an existing `.env`).
4. Runs `db:migrate` to apply the database schema.

Run it from your Hogsend project root (the directory with `docker-compose.yml`
and `.env.example`).

## Verify

After setup, confirm the instance is healthy and the schema is in sync:

```bash
hogsend doctor --json
```

Expect a `ok` verdict with `database` and `redis` components healthy and
`schema.inSync = true`. If you see `migration_pending`, re-run the migration
step; if `unreachable`, the API isn't running yet — start it with `pnpm dev`
(default port 3002), then re-run doctor.

## Typical first session

```bash
hogsend setup            # docker up, secret, .env, migrate
pnpm dev                 # start the API on :3002 (separate terminal)
hogsend doctor --json    # confirm ok
hogsend stats --json     # sanity-check metrics endpoint
```

## Notes

- `setup` is interactive by design; in a non-interactive / agent context,
  prefer running the underlying steps explicitly and then `hogsend doctor`.
- The admin key for local reads comes from your `.env` (`ADMIN_API_KEY` or
  `HOGSEND_ADMIN_KEY`); `doctor` itself needs no key.
