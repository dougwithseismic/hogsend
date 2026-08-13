---
"@hogsend/engine": patch
---

Contact merge carries `linked_accounts` with it, and contact deletion takes
them away.

A merge soft-deletes the loser, so the FK cascade never fires and a player's
proven platform link was silently stranded on a dead row. The merge now folds
`linked_accounts` like every other contact-scoped table: everything repoints to
the survivor, and when both contacts hold a live singleton link for the same
provider the survivor's row wins while the loser's is soft-unlinked with reason
`relinked` at that pair's own next version — never a blind repoint, which would
raise 23505 on the singleton partial-unique index and abort an ordinary
identify call.

Both deletion entry points (`softDeleteContact` and the admin delete route) now
soft-unlink every live link inside their existing transactions via the store's
new `unlinkAccountsForContactInTx`, hard-delete the token blobs, and — on
erasure — null the personal display fields while preserving the version
sequence. Without this a live row outlives its owner forever and an erased
player can never relink their own account under `onConflict: "reject"`.

Additive result fields: the resolver's merge results carry `linkUnlinks`
(`MergedLinkUnlink[]`) and `softDeleteContact` returns `linkUnlinks`
(`ContactUnlinkFact[]`), the facts the outbound `account.unlinked` emits are
built from post-commit.
