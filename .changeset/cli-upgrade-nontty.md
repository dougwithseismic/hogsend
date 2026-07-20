---
"@hogsend/cli": patch
---

`hogsend upgrade` no longer dies on pnpm 11's interactive modules-purge
confirmation when running non-interactively (fixes #573). With `--json`,
`--yes`, or no TTY, the package-manager child is spawned with `CI=true`, so
prompts like `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` are answered
non-interactively instead of aborting the dependency bump (and skipping the
skills refresh with it). Interactive runs keep the inherited environment so
the package manager can still ask.
