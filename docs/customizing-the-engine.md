# Customizing the Engine — the Extend → Patch → Eject ladder

> How to change `@hogsend/engine` behaviour with a known upgrade cost at each
> rung. This is the contract that sits inside the upgrade story in
> [UPGRADING.md](./UPGRADING.md); the injection seams it references are defined
> in [engine-boundary.md](./engine-boundary.md).

Hogsend ships the **framework** (`@hogsend/engine` + the other `@hogsend/*`
packages); your repo owns the **content** (journeys, templates, webhook
sources, routes, config, your own migrations). When you need to change engine
behaviour, climb the smallest rung that does the job:

| Need | Mechanism | Upgrade cost |
| --- | --- | --- |
| Add journeys, templates, sources, routes, middleware; swap a service | **Extend** via the public injection points in your own app code | none — `pnpm up` |
| Tweak a few lines of engine behaviour | **Patch** (`pnpm patch @hogsend/engine`) | patch re-applies on install; conflicts surface loudly on upgrade |
| Rewrite engine internals | **Eject** that one package into `vendor/<name>` | you maintain a fork **of that package only**; everything else still `pnpm up`s |

The 95% who only **Extend** get clean `pnpm up` upgrades forever. **Patch** and
**Eject** are deliberate, documented escape hatches you reach for only when
extension genuinely cannot express the change.

---

## 1. Extend (preferred — upgrade cost: none)

Everything routed through the engine's public API is additive: upstream never
ships files into your source tree, so there is nothing to merge on upgrade.
The committed semver surface is exported from `@hogsend/engine`
(`packages/engine/src/index.ts`). The injection seams (verbatim signatures from
[engine-boundary.md](./engine-boundary.md)):

```ts
createHogsendClient(opts?: {
  journeys?: Journey[];                              // → builds JourneyRegistry
  email?: {                                          // grouped email config
    provider?: EmailProvider;                        //   swappable email provider
    templates?: TemplateRegistry;                    //   YOUR src/emails registry
  };
  analytics?: PostHogService;                        // top-level: PostHog identity PULL (env)
  destinations?: DefinedDestination[];               // code-defined outbound destinations
  enabledJourneys?: string;                          // ENABLED_JOURNEYS filter
  clientJournal?: JournalShape;                      // client migration ledger
  overrides?: {                                      // advanced / test-only
    mailer?: EmailService;                           //   replace the TrackedMailer
    auth?: Auth;
    hatchet?: HatchetClient;
    db?: Database;
  };
}): HogsendClient;

// The capability-provider contracts (EmailProvider, PostHogService, + their
// supporting types) are owned by @hogsend/core and re-exported from
// @hogsend/engine — the canonical author surface. (Exception: the contract's
// SendEmailOptions imports from @hogsend/core, since @hogsend/engine exports a
// different, higher-level SendEmailOptions.) See docs/adr/0001-provider-boundary.md.

createApp(container: HogsendClient, opts?: {
  routes?: (app: OpenAPIHono<AppEnv>) => void;       // mount custom routers
  middleware?: MiddlewareHandler[];
  webhookSources?: WebhookSource[];                  // served at /v1/webhooks/:id
  onError?: ErrorHandler;
}): OpenAPIHono<AppEnv>;

createWorker(opts: {
  container: HogsendClient;
  journeys: Journey[];                               // journey durable tasks
  extraWorkflows?: unknown[];                         // extra tasks beyond built-ins
}): { start(): Promise<void>; stop(): Promise<void> };

defineJourney({ meta, run });                        // author a journey
defineWebhookSource({ meta, auth, schema?, transform });  // author an inbound webhook source
defineDestination({ meta, events, transform });      // author an outbound destination
```

### Recipes — "I want to X → extend via Y"

| I want to… | Extend via |
| --- | --- |
| Add a journey | `defineJourney({ meta, run })` in `src/journeys/`, add it to the array you pass as `journeys` to `createHogsendClient`/`createWorker`. |
| Add an inbound webhook source | `defineWebhookSource(...)` in `src/webhook-sources/`, pass it in `createApp(container, { webhookSources })`. |
| Fan events out to PostHog/Segment/Slack | No code — create a `webhook_endpoints` row with that `kind` + `config` via the admin API / `hs.webhooks`. To USE a shipped preset, that's it. |
| Add a custom outbound destination | `defineDestination(...)` in `src/destinations/`, pass it as `createHogsendClient({ destinations })` in BOTH `src/index.ts` and `src/worker.ts`. |
| Add a custom route | `createApp(container, { routes: (app) => app.openapi(route, handler) })`. |
| Add middleware | `createApp(container, { middleware: [myMiddleware] })`. |
| Edit an email's look | Edit the `.tsx` in your `src/emails/` — it's your content; no engine change. |
| Swap the email provider | Implement `EmailProvider` and pass `createHogsendClient({ email: { provider } })`. |
| Swap analytics (the identity PULL) | `createHogsendClient({ analytics })` (default: PostHog from env). Its role is now narrow — `getPersonProperties` for timezone resolution + the opt-in `bucket.syncToPostHog` mirror. Fanning events OUT is the destinations spine, not this provider. |
| Replace the whole mailer (advanced/test) | `createHogsendClient({ overrides: { mailer } })`. |
| Override auth or the Hatchet client (test-only) | `createHogsendClient({ overrides: { auth } })` / `{ hatchet }`. |
| Replace the error handler | `createApp(container, { onError })`. |

Because you register journeys/sources in **your own** app code (not by editing
a shared engine index), the index-file merge-conflict problem disappears.

> If a change you need has no seam, that is a gap in the public API — prefer
> opening an upstream issue/PR to add the seam over Patch/Eject. The ladder
> below is for when you cannot wait.

---

## 2. Patch (upgrade cost: re-applies on install; loud on conflict)

A surgical, line-local fix to engine source, held as a committed `.patch` that
pnpm re-applies on every install. Good while you wait for an upstream change.

```bash
pnpm patch @hogsend/engine          # opens an editable copy in a temp dir; prints its path
#  …edit the files in that printed dir…
pnpm patch-commit <printed-path>    # writes patches/@hogsend__engine@<ver>.patch
```

`pnpm patch-commit` does two things:

1. Writes `patches/@hogsend__engine@<version>.patch`.
2. Adds a `pnpm.patchedDependencies` block to your `package.json`:

   ```jsonc
   {
     "pnpm": {
       "patchedDependencies": {
         "@hogsend/engine@<version>": "patches/@hogsend__engine@<version>.patch"
       }
     }
   }
   ```

**Rules:**

- **Commit the `.patch` file** and the `package.json` change together. The patch
  is part of your source; without it the fix vanishes on the next install.
- pnpm **re-applies the patch on every `pnpm install`** automatically.
- On an engine upgrade where the patched lines moved or changed, **install fails
  loudly** with a message like `Could not apply patch … to …`. This is the
  built-in upgrade-conflict signal — pnpm refuses to silently drop your change.
  Refresh the patch (re-run the `pnpm patch` cycle against the new version) or,
  if it keeps conflicting, escalate to Eject.
- **Keep patches tiny and line-local.** Large patches conflict on every bump.

**Proof:** `packages/cli/scripts/patch-check.sh` demonstrates both halves of the
contract against a `pnpm pack`-ed local engine (no registry needed):

```bash
bash packages/cli/scripts/patch-check.sh
```

It (1) packs the engine, installs it into a throwaway consumer, patches a known
line, commits the patch, asserts the marker survives a clean reinstall, then
(2) repacks the engine with that line rewritten + a version bump and asserts the
reinstall **fails** with a patch-apply error. It is on-demand (it runs a real
install) and is **not** part of the always-on CI gate.

---

## 3. Eject (upgrade cost: you fork that one package)

When you must rewrite internals — or a patch will not stop conflicting — eject
the package. This copies its source into `vendor/<name>` and rewrites only that
dependency to a local `file:` link. **Every other `@hogsend/*` package keeps
upgrading via `pnpm up`.**

```bash
pnpm hogsend eject @hogsend/engine     # in a scaffolded app, or:
pnpm dlx @hogsend/cli eject @hogsend/engine
pnpm install                           # required follow-up
```

What `eject` does:

- Copies the package source into `vendor/engine/`, **excluding** `node_modules`,
  `dist`, `.turbo`, `.changeset`, `CHANGELOG.md`, and any `*.test.ts`.
- Drops `"private": true` from the vendored `package.json` (a `file:` dep must be
  installable); `name`, `version`, `exports`, and `dependencies` are left intact,
  so the vendored package's own `@hogsend/*` deps keep resolving from your
  `node_modules`.
- Rewrites the consumer dep from `workspace:^` / a semver range to
  `"@hogsend/engine": "file:./vendor/engine"` — and touches **nothing else**.
- Refuses to clobber an existing `vendor/engine` unless you pass `--force`.
- Prints `Now run: pnpm install` (it never runs the install itself).

```
vendor/
└── engine/
    ├── package.json        # private dropped; name/exports/deps intact
    ├── tsup.config.ts
    ├── tsconfig.json
    └── src/…               # the engine source, now yours to edit
```

**Build note (raw `.ts` engine).** `@hogsend/engine` ships raw TypeScript and is
bundled by your app's tsup `noExternal`. After ejecting, the package **name is
unchanged** (`@hogsend/engine`), so keep `@hogsend/engine` in your tsup
`noExternal` list and the vendored build works exactly as before.

**Upgrade contract after eject:**

- The ejected package no longer tracks upstream — you merge engine changes by
  hand into `vendor/engine`.
- **Every other `@hogsend/*` still `pnpm up`s normally** (this is the core
  invariant; the eject unit test asserts the non-ejected deps stay untouched).
- The two-track migration story is unaffected: engine migrations still ship from
  whatever `@hogsend/db` you resolve (see [UPGRADING.md](./UPGRADING.md)).

**How to un-eject:**

```bash
rm -rf vendor/engine
# restore the dependency range in package.json, e.g.:
#   "@hogsend/engine": "^1.4.0"
pnpm install
```

**Proof:** the binding proof of the file operations is the always-on unit suite
`packages/cli/src/__tests__/eject.test.ts` (run via `pnpm --filter @hogsend/cli
test`), which asserts correct copying, exclude pruning, the
"only-the-target-dep-is-rewritten" invariant, vendored `package.json`
sanitization, `--force` overwrite, no-clobber refusal, and a loud failure on a
missing dep. An optional end-to-end sandbox lives at
`packages/cli/scripts/eject-check.sh` (on-demand; runs a real install).

---

## 4. Decision guide

```
Can the change be expressed through a public seam
(createHogsendClient / createApp / createWorker / defineJourney /
 defineWebhookSource)?
        │
   yes ─┴─→  EXTEND.  Zero upgrade cost. Done.
        │
    no  │  Is it a small, line-local fix you can hold as a diff?
        │        │
        │   yes ─┴─→  PATCH.  Re-applies on install; refresh it if an
        │                     upgrade conflicts. If it keeps conflicting →
        │
        └─→  EJECT that one package.  You own vendor/<name> from here;
             everything else still pnpm up's.
```

Rule of thumb: **try Extend, fall back to Patch for surgical fixes, Eject only
when you are genuinely rewriting internals or a patch won't stop conflicting.**

---

## 5. Manual sandbox steps (out-of-monorepo, copy-paste)

Until the packages publish (Phase 4) and `create-hogsend` exists (Phase 3), you
can prove both rungs from the repo with `pnpm pack`:

```bash
# 0. From the repo root.
WORK="$(mktemp -d)"; cd "$WORK"

# 1. Pack the local engine to a tarball (no registry).
ENGINE_TGZ="$(cd /path/to/hogsend/packages/engine && pnpm pack --pack-destination "$WORK" | tail -1)"

# 2. A clean consumer outside the monorepo.
mkdir consumer && cd consumer
pnpm init
pnpm add "file:$ENGINE_TGZ"

# 3a. Patch cycle.
pnpm patch @hogsend/engine            # edit the printed dir, then:
pnpm patch-commit <printed-path>
rm -rf node_modules && pnpm install   # PASS: patch re-applies (grep your edit)

# 3b. Eject.
pnpm dlx @hogsend/cli eject @hogsend/engine   # or the built bin
pnpm install                                   # PASS: builds from vendor/engine
pnpm up @hogsend/core                          # PASS: non-ejected pkg still bumps
```

The scripted equivalents are `packages/cli/scripts/patch-check.sh` and
`packages/cli/scripts/eject-check.sh`.

---

## See also

- [engine-boundary.md](./engine-boundary.md) — the seams (D1–D6, per-file
  classification, public API).
- [UPGRADING.md](./UPGRADING.md) — the upgrade contract this ladder lives inside,
  including the "if you've patched or ejected" note.
