---
"@hogsend/core": minor
"@hogsend/db": minor
"@hogsend/email": minor
"@hogsend/engine": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-resend": minor
"@hogsend/studio": minor
"hogsend": minor
"create-hogsend": minor
---

Journey `where` builder — code-first trigger/exit conditions.

`trigger.where` and `exitOn[].where` now accept a builder function alongside
the declarative array, mirroring bucket criteria:

```ts
trigger: {
  event: "nps.detractor",
  where: (b) => b.prop("score").lte(3),
},
```

The function resolves ONCE at `defineJourney` time (via the existing
`criteriaBuilder`) into the byte-identical `PropertyCondition[]` POJOs, so the
stored `JourneyMeta`, registry zod parse, `checkExits`, admin routes, and
Studio all keep seeing plain data. Return a single condition or an array
(AND-ed). New types: `JourneyMetaInput`, `JourneyWhere`, `JourneyWhereBuilder`
in `@hogsend/core`. Fully backward compatible — the array form is unchanged
and remains the wire/HTTP format.
