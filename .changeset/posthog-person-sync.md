---
"@hogsend/engine": minor
"@hogsend/db": minor
"@hogsend/core": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/email": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/studio": minor
"hogsend": minor
"create-hogsend": minor
---

Contact → analytics-person propagation: the `posthog` destination preset
gains `config.syncPersons` — `contact.created` / `contact.updated` events
become `$set` captures of the contact's `properties` under its canonical
key (the same distinct id the identify loop uses), and a scope-`all`
`contact.unsubscribed` sets `hogsend_unsubscribed: true`. Privacy-first:
only `properties` travel, never email or identifiers; without the flag,
`contact.*` events are skipped (previously they fell through to the
generic capture branch, which could never address them correctly). The
engine-seeded destination (`ENABLE_POSTHOG_DESTINATION`) subscribes the
contact events and enables the flag, reconciling pre-upgrade seeded rows
without overriding an explicit operator `syncPersons: false`. (The full
engine line rides together per release discipline.)
