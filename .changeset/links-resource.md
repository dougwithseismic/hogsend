---
"@hogsend/client": minor
"@hogsend/engine": minor
"@hogsend/db": minor
---

hs.links resource with idempotent minting. POST /v1/admin/links accepts an
idempotencyKey (slugless dedupe) and a source field, and returns the existing
link on a compatible slug re-mint instead of a 409. The client gains
hs.links.create/get/list/update/archive/qr/qrUrl.
