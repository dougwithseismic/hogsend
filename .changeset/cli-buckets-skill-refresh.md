---
"@hogsend/cli": patch
---

Refresh the `hogsend-authoring-buckets` skill (SKILL.md + all reference files) for the bucket lifecycle API: typed `bucket.entered` / `bucket.left` refs, colocated `bucket.on("enter" | "leave" | "dwell")` reactions, `dwell` over the existing population, and `count`/`has`/`members`/`membersIterator` access. The `BucketId` union + `bucketEntered`/`bucketLeft` helpers are marked deprecated. Republishes so `hogsend skills add` / `hogsend upgrade` pull the updated content.
