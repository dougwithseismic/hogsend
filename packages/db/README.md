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
