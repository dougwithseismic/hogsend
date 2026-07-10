---
"@hogsend/studio": patch
"@hogsend/engine": patch
"@hogsend/core": patch
"@hogsend/db": patch
"@hogsend/email": patch
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/js": patch
"@hogsend/react": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-telegram": patch
"hogsend": patch
---

Studio journey detail: the Definition and Funnel cards move off the top of the page and into the flow's side panel, shown when no node is selected. The workflow is now the first thing on the page; selecting a node still swaps the panel to the node inspector. The funnel restacks vertically (label, drop badge, share of enrolled, count, ratio bar per stage) so it reads cleanly at panel width, and the node-type legend is gone — the "Left the journey" strip closes the funnel instead. Engine-line packages are version-bumped in lockstep with no code changes.
