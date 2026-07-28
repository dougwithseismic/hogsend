---
"@hogsend/engine": minor
---

Trust is a property of the key: the resolver accepts an explicit
`ResolvePolicy`.

`resolveOrCreateContact`, `resolveContactNoCreate`, `ingestEvent` and
`ingestTransformResult` gain an optional `policy` option, and the
`ResolvePolicy` / `IdentityKind` types are exported. A policy declares the
caller's trust once — `create` ("on-miss" | "refuse-on-miss"), `allowMerge`
("any" | "anonymous-only"), and `trustedKinds` (the key kinds this caller is
authorized to assert) — instead of the resolver re-deriving it from
`restrictToAnonymous`/`allowCreate` plus which keys happen to be present.
Every built-in caller now declares its policy explicitly.

Behaviour is identical for every reachable input:

- The legacy `restrictToAnonymous` / `allowCreate` fields stay accepted and
  honoured, now marked `@deprecated`. An absent policy means exactly what it
  always did. Supplying both shapes on one call throws — no precedence rule
  exists.
- The refusal key remains DERIVED (`userId ?? anonymousId`) inside
  `resolveContactNoCreate` and is never accepted from a caller.
- `allowMerge: "never-identified-pair"` is a reserved value naming the
  not-yet-implemented "never merge two already-identified persons" rule;
  selecting it throws.
- `trustedKinds` is enforced: a supplied key whose kind is absent from the
  caller's declared `trustedKinds` now throws — before any advisory lock is
  taken, before the transaction opens, and without writing a row. The default
  when no policy is supplied trusts all four kinds, so callers on the legacy
  shape are unaffected, and every built-in route is already gated one layer
  up — the throw is defence in depth against a future route that forgets the
  gate, not a behaviour consumers can reach today.
