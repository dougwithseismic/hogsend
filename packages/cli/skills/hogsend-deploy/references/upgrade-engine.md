# Upgrade the engine + refresh vendored skills

Hogsend is a versioned engine you consume as a dependency. After a new engine
release you want your app's `@hogsend/*` deps AND the vendored Claude Code
skills under `.claude/skills` to move together — so the code you run and the
agent guidance that drives it stay in lockstep.

> This is a side-effecting operation: it bumps dependencies and rewrites files
> in `.claude/skills`. Run it deliberately, review the diff, and re-test before
> deploying.

## One step: `hogsend upgrade`

```bash
hogsend upgrade
```

This does both halves in order:

1. **Bumps every `@hogsend/*` dependency** declared in your `package.json`
   (`dependencies` + `devDependencies`) to `latest`, using the package manager
   detected from your lockfile.
2. **Refreshes the vendored skills** in `./.claude/skills` to match, then
   version-stamps them so `hogsend doctor` can later tell when they fall behind.

If the dependency bump hard-fails, the skills refresh is skipped (fix the bump,
then re-run) — the two never drift apart silently.

### Useful flags

```bash
hogsend upgrade --to 1.4.0      # pin a specific target instead of latest
hogsend upgrade --pm pnpm       # force a package manager (default: from lockfile)
hogsend upgrade --cwd ./apps/x  # run against a different project root
hogsend upgrade --deps-only     # bump deps only; leave skills untouched
hogsend upgrade --skills-only   # refresh skills only; don't touch deps
hogsend upgrade --yes           # skip the confirmation prompt
hogsend upgrade --json          # non-interactive, single JSON result (implies --yes)
```

`--deps-only` and `--skills-only` are mutually exclusive.

## Refresh skills on their own

If you only need to re-vendor the bundled skills (e.g. you bumped the engine by
hand, or want the latest guidance without changing versions), use either:

```bash
hogsend upgrade --skills-only        # refresh + re-stamp via upgrade
hogsend skills add --all --force     # copy every bundled skill, overwriting
```

`hogsend skills add --all --force` copies all bundled skills into
`./.claude/skills/<name>/`, overwriting existing copies (`--force` is what makes
it overwrite rather than skip), and re-stamps the installed set. Without
`--force`, already-installed skills are skipped. You can also target one skill:

```bash
hogsend skills list                  # see what's bundled + what's installed
hogsend skills add hogsend-cli --force
```

## The `hogsend doctor` staleness nudge

`hogsend doctor` (the health probe; see the hogsend-cli skill) does a
best-effort check: if your vendored skills were installed by an OLDER CLI than
the one now running, it prints a nudge:

```
Skills out of date
Vendored Claude skills are from v1.2.0; this CLI is v1.4.0.
Refresh: hogsend upgrade (deps + skills) or hogsend skills add --all --force.
```

This is silent when there's no stamp (not a tracked app dir) and suppressed in
`--json` mode (the staleness verdict is still surfaced under the `skills` key of
the JSON output instead). Treat the nudge as your signal to run `hogsend
upgrade`.

## After upgrading

1. Review the dependency + `.claude/skills` diff.
2. Re-run your type-check / tests against the new engine line.
3. Re-deploy (push to your deploy branch — see
   `references/railway-two-services.md`). The api's pre-deploy `db:migrate`
   applies any new engine migrations that came with the bump.
4. Verify the live instance with `hogsend doctor --url <prod> --json` and
   confirm the schema is in sync.

> This is the **consumer** upgrade flow for your own app. It is NOT the
> maintainer's npm release / version-line process for publishing `@hogsend/*` —
> that's the separate `release` skill.
