# BACKLOG — GTM Extension, Release 1: Refinement

Ordered queue. Build top-down. See `DECISIONS.md` for locked global choices and the quality gates.

| # | PRD | Status | Depends on | Scope |
|---|---|---|---|---|
| 01 | [Enrichment provider contract + container wiring](prds/01-enrichment-provider-contract.md) | `[x]` | — | New BYO-provider kind: core contract, registry, singleton, env preset, container resolution, `"refine"` key kind |
| 02 | [Enrichment lookup ledger](prds/02-enrichment-lookup-ledger.md) | `[x]` | — | `enrichment_lookups` table + migration — TTL cache, negative cache, budget accounting, exactly-once |
| 03 | [`refineContact()`](prds/03-refine-contact.md) | `[x]` | 01, 02 | The one new public function: gate chain, trait mapping, write through `ingestEvent` |
| 04 | [`@hogsend/plugin-apollo`](prds/04-plugin-apollo.md) | `[x]` | 01 | Reference provider, fixture-driven, injectable `fetch` |
| 05 | [Cold-channel gate enforcement](prds/05-cold-channel-gate.md) | `[x]` | — | Wire the declared-but-unused cold posture into `checkActionAudience` |
| 06 | [Contact leaderboard](prds/06-contact-leaderboard.md) | `[x]` | — | GIN index + `orderBy`/`orderProperty` on admin contacts + Studio sortable column |
| 07 | [GTM example, scoring recipe, docs](prds/07-gtm-example-and-docs.md) | `[ ]` | 03, 04, 06 | Working example buckets + nightly recompute + `docs/gtm.md` and the guide |
| 08 | [`contact.refined` outbound event](prds/08-contact-refined-outbound.md) | `[ ]` | 03 | Optional, cuttable — catalog entry across three hand-synced copies |
| 09 | [`withDurableGate` primitive](prds/09-with-durable-gate.md) | `[ ]` | 03 | **P0** — extract the positional-journal shape so a fifth bug of that class cannot be written |
| 10 | [Test database isolation](prds/10-test-db-isolation.md) | `[x]` | — | **P0** — 150 test files pin DATABASE_URL to the shared main-checkout DB with no env escape |

## Legend

- `[ ]` not started
- `[~]` shipped to a seam — in-repo path complete and green, an external dependency enumerated
- `[x]` done

## Notes

- 05 and 06 are fully independent and can be built at any point; they are ordered here to keep the
  refinement spine contiguous.
- 08 is cuttable. Drop it if the run is long; nothing depends on it.
- The only human seam in the whole stack is a **live Apollo API key**, needed solely for the PRD 07
  end-to-end smoke. Everything else is fixture- and fake-driven.
