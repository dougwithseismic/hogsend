---
"create-hogsend": patch
---

Magical local onboarding + a smoother scaffolder CLI:

- **One-command `pnpm bootstrap`** in scaffolded apps — checks Docker, generates `.env` with a real `BETTER_AUTH_SECRET`, auto-remaps conflicting host ports (so multiple stacks coexist), mints a Hatchet token, and runs migrations. Idempotent.
- **`--yes` / `-y`** for a fully non-interactive scaffold, and **`.`** to scaffold into the current folder.
- **Package-manager-aware** command hints (npm/yarn/bun) and clearer step-by-step progress, pointing at docs.hogsend.com.
- **Fix:** the scaffolded email logo no longer renders the literal `{{APP_NAME}}` — it's now substituted with your app name (added `logo.tsx` to the token-substituted files).
