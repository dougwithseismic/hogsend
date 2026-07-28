---
"@hogsend/engine": patch
---

A campaign targeting a bucket now reaches every member of that bucket.

`bucket_memberships.user_id` holds the canonical contact key
(`external_id ?? anonymous_id ?? id`), but the audience query joined
`contacts.external_id`. A contact whose canonical key is not its `external_id`
— an email-only subscriber keyed on its uuid, someone who gave you their
address but never created an account — matched nothing and was silently dropped
from the recipient list.

They were genuine active members of the bucket. They simply never received the
campaign, and nothing surfaced it: a send report reading "40 of 40 delivered"
looks complete whether or not the audience was built correctly.

**What you will observe.** The next bucket-targeted campaign reaches those
members, so recipient counts rise. Nothing is sent retroactively — this changes
who a FUTURE send resolves, not history.

Suppression is unaffected. Every gate lives in the same condition set applied to
this query and is keyed on the recipient email rather than the join column, so a
newly-visible member passes the identical unsubscribed/suppressed check as
everyone else, and the mailer re-checks preferences per send.
