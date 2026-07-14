---
"@hogsend/core": patch
"@hogsend/engine": minor
---

Studio journey graph: resolve `Templates.X` / `Events.X` to their real values so email steps preview exactly and wait/digest nodes report live metrics.

The graph is built from `runFn.toString()`, so a member expression like `Templates.DOCS_WELCOME` or `Events.NPS_SUBMITTED` only yields the identifier text — never the runtime value. Two problems followed. Email-template previews had to *guess* the registry key, and silently failed for slash- or mixed-separator keys (`docs/welcome`, `docs/setup-offer`), falling back to only the templates a journey had actually sent — every other step showed "No sends recorded yet". Worse, an `Events.X` wait/digest node fell back to a positional `wait-event:<idx>` id marked unstable, which never matched the runtime `currentNodeId` (`wait-event:<resolvedValue>`), so that node silently showed zero live/failed counts.

`createHogsendClient` gains an optional `journeyConstants: { templates, events }`: pass your `Templates`/`Events` `as const` maps and the graph builder resolves those member expressions to their real values before assigning ids — exact previews with no send data, and stable, join-safe `wait-event:<value>` / `digest:<value>` ids. Resolution is object-qualified (only the conventional `Templates`/`Events` bindings) so a colliding property name on an unrelated object can't resolve to the wrong value. When `journeyConstants` isn't wired, a separator-agnostic segment heuristic (`resolveTemplateKeyFromConst`, exported from `@hogsend/core`) still resolves send-node previews as a fallback.
