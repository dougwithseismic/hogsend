# PRD 05 — Cold-channel gate enforcement

**Depends on:** none (fully independent) · **Status:** `[ ]`

## Goal

Close a declared-but-open safety gap. `ColdPosture`, `resolveColdPosture`, `isColdChannelAllowed`
and `ContactSourceRegistry.isProspectSource` all exist, are exported, and are called from **zero
production sites** — the cold gate is declared but not wired. A GTM release is precisely when
sourced prospects start flowing, so this must be live before refinement ships.

## Locked decisions

- The gate belongs in `checkActionAudience` in `packages/engine/src/lib/connector-actions.ts` — the
  one function that already resolves the contact and already returns `ConnectorActionSkipped`.
- Default posture is unchanged: `defaultColdPosture()` is `{ email: "allow" }`, so a sourced prospect
  may be emailed but **not** messaged on a chat connector unless the source explicitly opts in.
  This is a behaviour change for any deployment already using contact sources with connectors — it is
  the intended, safe direction, and it is the whole point of the primitive.
- New skip reason: `"cold_channel_blocked"`, added to the `ConnectorActionSkipped` reason union.
- The gate runs **inside** the memo closure, alongside the existing preference gate, so the verdict
  replays verbatim.
- Consistent with the existing gate's failure posture: an unresolvable contact or a throwing lookup
  **fails open** (allows the send). Only a positively-identified cold prospect on a blocked channel
  is stopped. Do not change the surrounding fail-open semantics.
- A contact whose `source` is null, or whose `source` does not name a registered contact source, is
  **not** a prospect and is unaffected.

## Acceptance criteria (EARS)

1. WHEN a connector action targets a contact whose `source` names a registered contact source AND
   that source's posture blocks the connector's channel, the system SHALL return
   `ConnectorActionSkipped` with `reason: "cold_channel_blocked"` and SHALL NOT call the connector.
2. WHEN the same contact is targeted by a channel the posture allows the system SHALL proceed normally.
3. WHEN the contact's `source` is null the system SHALL proceed normally.
4. WHEN the contact's `source` names a source that is not in the registry the system SHALL proceed
   normally.
5. WHEN the contact cannot be resolved the system SHALL proceed normally (fail open, unchanged).
6. WHEN the action has no `audience` (an ops/channel-directed action) the system SHALL proceed
   normally — the cold gate applies only to member-audience actions, exactly like the preference gate.
7. WHEN the gate skips an action the system SHALL log once at info with the contact source id and the
   blocked channel, so a deliberate posture is observable in production.

## Tasks

### T5.1 — Wire the gate
_Boundary:_ `packages/engine` · _Depends:_ —

Extend `checkActionAudience`; add `"cold_channel_blocked"` to the skip-reason union. Read the
registry via `getContactSourceRegistry()`.

_Test:_ all seven acceptance criteria in the existing connector-action test file. AC 6 in particular
guards against over-blocking ops alerts.

## Seams

None.

## Done when

Seven acceptance criteria pass, gates green, and the existing connector-action tests still pass
unchanged (no regression in the preference gate).

## Implementation Notes

_(filled in during build)_
