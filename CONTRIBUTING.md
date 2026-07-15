# Contributing to Hogsend

Thanks for wanting to contribute. Hogsend is a work in progress and we keep things simple.

## Getting Started

Use Node.js 22.x (`>=22.13`) and the repository-pinned pnpm `11.12.0`. pnpm 9
and 10 are not supported; Corepack reads the exact version from `package.json`.
Install Corepack first if your Node distribution does not include it.

```bash
git clone https://github.com/dougwithseismic/hogsend.git
cd hogsend
corepack enable
pnpm bootstrap      # Docker + .env + deps; auto-remaps busy host ports
pnpm dev            # Starts API on port 3002
```

In a separate terminal:

```bash
cd apps/api
hatchet worker dev  # Starts worker with hot-reload
```

Hatchet dashboard: `http://localhost:8888` (login: `admin@example.com` / `Admin123!!`)

## Making Changes

1. **Fork and branch** — create a feature branch from `main`
2. **Keep it small** — one concern per PR. If it touches more than a few files, split it
3. **Run checks before pushing:**

```bash
pnpm lint           # Biome check
pnpm check-types    # TypeScript across all workspaces
pnpm --filter @hogsend/api test   # Tests
```

4. **Commit messages** — we use [Conventional Commits](https://www.conventionalcommits.org/). Format: `type(scope): description`. Lefthook enforces this on commit.

   ```
   feat(api): add batch ingest endpoint
   fix(email): handle missing template gracefully
   docs: update journey context API table
   ```

5. **Open a PR** against `main` with a clear description of what and why

## Project Structure

```
apps/api/           Hono REST API + Hatchet worker
packages/core/      Journey types, schemas, condition engine
packages/db/        Drizzle ORM schema and migrations
packages/email/     Resend client, React Email templates
```

## Code Style

- **Biome** handles linting and formatting (not ESLint/Prettier)
- 2-space indent, double quotes, semicolons
- ESM-only, `.js` extensions in relative imports
- No comments unless the "why" is non-obvious

## Adding a Journey

1. Add event/template constants to `apps/api/src/journeys/constants/`
2. Create `apps/api/src/journeys/your-journey.ts` using `defineJourney()`
3. Import in `apps/api/src/journeys/index.ts` and add to `allJourneys`
4. The worker picks it up automatically

## Adding an API Route

1. Define Zod schemas for request/response
2. Create the route with `createRoute()` + `.openapi()`
3. Register in `src/routes/index.ts` via `registerRoutes`

## Tests

Tests use vitest and live in `apps/api/src/__tests__/`. Run with:

```bash
cd apps/api && pnpm test
cd apps/api && pnpm test:watch
```

Tests call `app.request()` directly against the Hono app — no HTTP server needed.

## Reporting Issues

Use [GitHub Issues](https://github.com/dougwithseismic/hogsend/issues). Pick the right template (bug, feature request, or question) and fill it out. The more context, the faster we can help.

## License

By contributing, you agree that your contributions will be licensed under the [Elastic License 2.0](LICENSE).
