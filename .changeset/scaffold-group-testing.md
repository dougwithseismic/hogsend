---
"create-hogsend": patch
---

The scaffold now ships a working group-wait test setup: `src/groups.d.ts` is an ACTIVE module augmentation (the previous stub was a script — uncommenting its `declare module` block replaced `@hogsend/core`'s types wholesale instead of merging; the bare `import "@hogsend/core"` is what makes it merge), a `test-group-wait` smoke journey (group-scoped `waitForEvent` with `actorUserId`, no external deps, companion to `test-onboarding`), and a harness test covering teammate resume, cross-company isolation, and timeout via `triggerGroups`.
