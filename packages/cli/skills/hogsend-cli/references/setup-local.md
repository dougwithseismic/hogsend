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

## Headless / agent-driven local instance (zero TTY)

The whole scaffold → bootstrap → run path works with no prompts; every outcome
is an exit code, a `.env` line, a log line, or `--json`.

```bash
# 1. One-shot scaffold (zero prompts; --yes implies install + bootstrap)
pnpm dlx create-hogsend@latest my-app --yes \
  --domain mysite.com \
  --admin-email you@example.com --admin-password 'min-8-chars' \
  --posthog                      # keyless intent; or --posthog-key phc_…

# 2. (If you skipped --yes) idempotent setup — exit 0 = all steps succeeded
cd my-app && pnpm bootstrap      # Docker infra, .env, migrate (verified),
                                 # HOGSEND_API_KEY + HOGSEND_ADMIN_KEY minted

# 3. Run as background processes YOU manage, then poll readiness
pnpm dev &          # API — non-TTY boots emit "Hogsend API ready"
pnpm worker:dev &   # worker — emits "Hogsend worker ready"
curl -fs localhost:3002/v1/health   # poll until "status":"healthy"

# 4. Operate
pnpm hogsend doctor --json       # first call, verifies keys + schema + infra
pnpm hogsend stats --json
```

Key facts:

- **First admin**: `--admin-email` writes `STUDIO_ADMIN_EMAIL` into the env;
  the API mints the admin on FIRST BOOT (empty user table). No
  `--admin-password` (min 8 chars) ⇒ one is generated and printed ONCE — grep
  the boot log for `First admin created`. Fallback:
  `hogsend studio admin create --email … --password … --json`.
- **Failures carry their cause**: in a non-TTY run, every bootstrap failure
  prints the full underlying output beneath the one-liner (stderr tail, stack
  trace, the handshake API child's boot log) — read that before retrying. In a
  terminal, `HOGSEND_DEBUG=1` forces the same detail.
- **Health semantics**: `migration_pending` ⇒ run `pnpm db:migrate`;
  `degraded` ⇒ serving but check `components.{database,redis,worker}`;
  `components.worker` is the worker's Redis heartbeat.
- **PostHog headless**: browser OAuth can't run headless — set
  `POSTHOG_PERSONAL_API_KEY` on the instance instead (person reads + loop
  provisioning work automatically); `hogsend connect posthog --provision-only`
  re-wires the event loop from an already-stored credential.

## Notes

- `setup` is interactive by design; in a non-interactive / agent context,
  use the headless path above (`create-hogsend` flags + `pnpm bootstrap`),
  then `hogsend doctor --json`.
- The admin key for local reads comes from your `.env` (`ADMIN_API_KEY` or
  `HOGSEND_ADMIN_KEY` — `pnpm bootstrap` mints the latter); `doctor` itself
  needs no key.
