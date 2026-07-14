---
"@hogsend/cli": minor
---

feat: `hogsend connect` no longer dead-ends on a missing admin key. When the target is the LOCAL instance and `./.env` holds a `DATABASE_URL`, the CLI offers to mint a `full-admin` key straight into the database (the same shell-gated trust model as `hogsend studio admin create`) and persists it as `HOGSEND_ADMIN_KEY` in `.env` — interactive confirmation required, never against a remote `--url`. Everywhere else the terse "no admin key configured" error is replaced with a guided explanation of how to get one locally vs on a deployed instance.
