---
"create-hogsend": minor
---

PostHog setup at scaffold time: `create-hogsend` asks "Are you using
PostHog?" (or take the non-interactive `--posthog-key` / `--posthog-host`
/ `--no-posthog` flags), validates the project key and region, and
materializes `POSTHOG_API_KEY`, `POSTHOG_HOST`,
`ENABLE_POSTHOG_DESTINATION=true`, and a freshly minted
`POSTHOG_WEBHOOK_SECRET` into the scaffolded env — so capture, person
writes, the outbound PostHog destination, and a locked inbound webhook
endpoint all work from first boot. The next-steps output ends with the
one command that finishes the loop once deployed: `hogsend connect
posthog`. Skipping the prompt leaves the scaffold byte-identical to
before.
