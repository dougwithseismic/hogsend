# Claude Code skills

This folder holds the Hogsend **agent skills** — focused, on-demand guides that
teach Claude Code how to build with this app: journeys, emails, buckets, webhook
sources, custom workflows, the database, and deploys.

Claude Code discovers everything under `skills/` automatically — you don't invoke
them by hand. The repo's `CLAUDE.md` maps each task to its skill.

These were vendored into your project at scaffold time. After you upgrade
`@hogsend/engine`, refresh them to the latest guidance with your package runner:

    pnpm dlx hogsend skills add --force      # or: npx hogsend skills add --force

`settings.local.json` (your personal Claude Code settings) is gitignored, but the
skills and `CLAUDE.md` are committed so your whole team — and their agents — share
the same guidance.
