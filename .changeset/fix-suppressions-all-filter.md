---
"@hogsend/engine": patch
"@hogsend/studio": patch
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/core": patch
"@hogsend/db": patch
"@hogsend/email": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-resend": patch
"hogsend": patch
---

fix(admin): suppressions "All" view listed every contact, and harden two sibling unbounded-query routes

The admin Suppressions "All" filter built no WHERE clause (`typeFilter` returned
`undefined`), so Drizzle returned every `email_preferences` row — making every
contact look suppressed even though none were (deliverability was never affected;
the send-gate only blocks on `suppressed`/`unsubscribedAll`). The "All" case now
restricts to genuinely-suppressed recipients (`suppressed OR unsubscribedAll OR
bounceCount > 0`).

- **preferences PUT**: un-suppressing (`suppressed: false`) now also clears
  `bounceCount`/`lastBounceAt`, so a bounced recipient actually leaves the list
  instead of being pinned there forever.
- **studio contact drawer**: its un-suppress button now sends `unsubscribedAll:
  false` too, so it works for unsubscribed contacts (previously a no-op for them).
- **bulk events replay**: refuses an unscoped replay (`400`) instead of silently
  re-pushing the most-recent events through ingestion when no `eventIds`/filter
  is given.
- **sends CSV export**: signals truncation via `X-Hogsend-Export-Truncated` when
  the 50k row cap is hit, so a partial export isn't mistaken for the full history.
