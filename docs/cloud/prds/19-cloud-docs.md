# PRD 19 — Cloud documentation

## Scope
Document the whole seamless path on the docs site (apps/docs) once 15–18 are
real. Pages (exact IA to fit the existing docs nav — extend, don't restructure):

1. **Cloud quickstart** — nothing → live hosted instance: `pnpm dlx
   create-hogsend my-app --cloud`, what the OTP step looks like, what
   provisioning-on-first-publish means for the first `publish` (it's longer,
   once), where credentials land, `hogsend open` / `env pull`.
2. **CLI cloud reference** — `signup`, `login` (device flow AND `--email`),
   `whoami`, `logout`, `publish` (flags incl. `--env`, `--no-wait`, `--json`,
   `--allow-upgrade`), `open`, `env` — refusal catalog included (the exact
   errors and remedies the CLI prints), headless/agent usage patterns.
3. **Agents & MCP** — the `cloud_*` tools, the credential model (shared file,
   token never on the wire), an end-to-end agent transcript example
   (scaffold → signup → verify → publish → status).
4. Touch-ups where the flow is already mentioned: the existing self-host vs
   cloud copy, and the scaffold outro copy in `create-hogsend/src/cloud.ts` if
   the shipped flow drifted from what it promises.

Register laws: every line a fact (deletion test); commands verbatim from the
shipped CLI (copy-paste runnable — verify each against the real binary, not
from memory); no marketing register; screenshots only if captured from the
real flow.

_Boundary:_ apps/docs (+ create-hogsend copy touch-up). _Depends:_ PRD 15–18
shipped.

## EARS acceptance criteria
- WHEN a reader follows the quickstart verbatim on a clean machine, every
  command SHALL be copy-paste correct against the shipped versions (each
  command verified against the real CLI during authoring).
- WHEN the CLI reference lists a flag or refusal, it SHALL exist in the shipped
  CLI with matching text; no documented surface SHALL be aspirational.
- WHEN the MCP page shows the agent transcript, it SHALL come from a real run
  (fake substrate acceptable, noted honestly if used).
- WHEN the docs build + lint gates run, they SHALL pass; nav SHALL include the
  new pages in the cloud section.

## Tasks
1. **Quickstart + CLI reference + MCP page + touch-ups** — author all pages,
   verify every command against the real binaries, sync outro copy if drifted,
   wire nav. _Boundary:_ apps/docs, packages/create-hogsend. _Depends:_ —
