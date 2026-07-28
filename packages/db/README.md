# @hogsend/db

Drizzle ORM schema, the bundled **engine migrations** (`drizzle/`), the hardened
migrator (advisory lock + timeouts), and the count-based schema-version probe for
[Hogsend](https://github.com/dougwithseismic/hogsend).

The published tarball includes the `drizzle/` folder (SQL + `meta/_journal.json`)
because the migrator loads it from disk at runtime — engine migrations ship
versioned with this package. See
[RELEASING.md](https://github.com/dougwithseismic/hogsend/blob/main/docs/RELEASING.md)
and [UPGRADING.md](https://github.com/dougwithseismic/hogsend/blob/main/docs/UPGRADING.md).

This package ships raw TypeScript source; consumers bundle it via their own build
(tsup `noExternal`).

## `contact_id` on the history tables

`user_events`, `journey_states`, `bucket_memberships`, `email_sends` and
`email_preferences` each carry a nullable `contact_id uuid` with one partial
btree index (`WHERE contact_id IS NOT NULL`). It is **bookkeeping — nothing reads
it.** Every read path still resolves history through `user_id`; the column is
dual-written at each insert site, repointed by contact merges, and filled for
older rows by the engine's periodic `identity-contact-id-backfill` sweep.

A NULL is legal and permanent: a row whose `user_id` owns no contact (a refused
anonymous ingest, a keyless raw send) is a real observation with no owner, so the
column's completion criterion is not "zero NULLs". What must hold is that every
row a live contact owns is stamped, and every stamp points at a contact that
really owns that row's key — checked by `GET
/v1/admin/maintenance/contact-id-verify`, which is also the gate for the release
that flips reads onto the column. See
[UPGRADING.md](https://github.com/dougwithseismic/hogsend/blob/main/docs/UPGRADING.md).
