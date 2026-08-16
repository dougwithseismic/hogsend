# BACKLOG — Cloud complexity distillation

Ordered queue. Status legend: `[ ]` not started · `[~]` shipped-with-seam · `[x]` done.

| # | PRD | Status | Depends | Scope |
|---|-----|--------|---------|-------|
| 01 | [Extract SES diagnostic harnesses](prds/01-extract-ses-diagnostics.md) | `[x]` | — | Move `ses-walkthrough` + `ses-delivery-proof` out of `src/` into an excluded `apps/cloud/diagnostics/` subtree; app gates stop seeing them; tests still run standalone; harness commands still work. **Build. DONE — all gates green, zero behavior change.** |
| 02 | [RelayProvider seam](prds/02-relay-provider-seam.md) | `[ ]` | 01 (conceptually) | Design-only: neutral relay contract above the existing `SesClient`, strangler migration order, open decisions. **No code this run.** |
| 03 | [Lean the diagnostics on AWS-native tooling](prds/03-lean-diagnostics.md) | `[x]` | 01 | **Closed — no code (premise refuted).** Evidence scan: 18/20 SES verbs have direct runtime callers, so the exhaustive `ses-walkthrough` is genuine full-contract drift protection, not ceremony — shrinking it would remove coverage for 13 load-bearing verbs (a regression). `ses-delivery-proof` is ALREADY simulator-only with no synthesized events. LocalStack rejection stands. The real diagnostics simplification was PRD 01. |
| 04 | [Railway provisioning plane distillation](prds/04-provisioning-distillation.md) | `[x]` | — | **Built.** Distilled the ~420-line `runProvisionPipeline` god-function into a `RunState`-driven, `STEP_FNS`-mapped pipeline over the existing `PROVISION_STEPS` list (T1, `b0bea973`); behavior-preserving, 65/65 provision tests + all gates green, zero public-signature change. T2 (isolated step tests) descoped lean-first — the list-driven contract is already pinned by the existing suite. Sweeps + build-host deferred (healthy). |

## Notes

- Publish mode: local-commits-only, worktree `.claude/worktrees/cloud-distill` (branch
  `refactor/cloud-distill`).
- PRD 01 is the only build work this run. PRD 02 ships as an approved design doc.
