---
"@hogsend/core": patch
"@hogsend/engine": patch
---

Fix Studio journey email preview for slash-namespaced template registries. The
graph route resolved a `send` node's template key by kebab-casing the const name
(`DOCS_WELCOME` → `docs-welcome`), which never matched slash- or mixed-separator
registry keys (`docs/welcome`, `docs/setup-offer`). Resolution silently fell back
to observed sends, so only templates a journey had *actually sent* would preview —
every other step showed "No sends recorded yet". Resolution is now SEGMENT-based
(`resolveTemplateKeyFromConst`, exported from `@hogsend/core`): the const name and
each registry key are split on any of `/ _ -` and compared as segments, so every
statically identifiable email step previews from its defaults with no send data.
