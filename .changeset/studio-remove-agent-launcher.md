---
"@hogsend/studio": patch
---

Remove the floating bottom-right agent launcher — it overlapped page UI, and the
header "Agent" button already opens the same panel. Also reword the email-step
preview fallback: when a step's template can't be identified from the journey
source, Studio now says so plainly instead of the misleading "No sends recorded
yet — preview appears once this journey sends".
