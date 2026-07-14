---
"create-hogsend": minor
"@hogsend/studio": minor
---

Agent-mode error pass-back + Studio launcher cleanup.

- **Bootstrap failures now carry their full cause.** In a non-TTY run (an agent driving `pnpm bootstrap`), every failure prints the underlying output beneath the one-liner: the Docker daemon's stderr, the Hatchet token mint's last attempt log, API-key mint stack traces, and — previously discarded entirely — the PostHog-handshake API child's boot log. In a terminal the one-liners stay clean; `HOGSEND_DEBUG=1` forces the same detail. The scaffolder's own fatal errors follow the same rule (full stack in non-interactive runs).
- **Studio: the bottom-right agent launcher bubble is removed.** It overlapped page UI; the header **Agent** button is the single entry point to the co-working agent panel.
