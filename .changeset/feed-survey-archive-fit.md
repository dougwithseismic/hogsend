---
"@hogsend/react": patch
---

Fix the feed item's swipe-to-archive affordance colliding with tall, dynamic-height rows (e.g. an in-app survey's NPS option grid). The archive button is now pinned to the row's top-right — aligned with the always-short title — instead of the vertical center, so it no longer lands on top of a survey's answer row. The "Archive" swipe label is hidden unless the row is actually being swiped, and the swipe gesture is guarded against firing on a plain hover (a stale pointer origin previously set a false `data-swiping`, which leaked the label through the hover-tinted track).
