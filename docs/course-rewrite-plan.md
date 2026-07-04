# Course prose rewrite — execution plan

Goal: every chapter of `apps/course/content/courses/growth-with-posthog/` reads at the
chapter-0/1 bar — conversational guide-through voice, standalone (no load-bearing
cross-chapter references), every term defined on first use, no atomization residue
("the next code block", "the journeys above"), no course-logistics openers, prose that
argues instead of bullet dumps.

The writing contract is `apps/course/CLAUDE.md` (authored from a 16-agent audit +
voice-fingerprint pass, 2026-07-04). Full per-chapter audit findings (verbatim offender
quotes): session scratchpad `course-rewrite-audit.md`; re-runnable via the audit
workflow if lost.

Method per chapter: rewrite prose to the contract (interactive blocks byte-identical —
persistence keys; atom filenames frozen — progress keys) → regenerate workbook manifest
and diff block keys against baseline (must be EMPTY) → re-audit with a fresh agent
(must grade "good") → `check-types` gate → residue grep → one commit.

Legend: `[ ]` todo · `[~]` built-to-seam · `[x]` done

## Phase 0 — Foundations

- [x] Audit all 15 chapters + voice fingerprint (16 background agents)
- [x] Authoring guidelines at `apps/course/CLAUDE.md`
- [x] Manifest baseline snapshot (163 block keys) + gates green pre-rewrite
- [x] Branch `feat/course-prose-rewrite`; commit guidelines + this plan

## Phase 1 — The chapters Doug called out + non-standalone (worst first)

- [x] 07-driving-traffic — polish-grade voice failures, 17 xrefs, 10 undefined terms; course-logistics opener ("deliberately seventh"), mid-atom CheckIn, endings without landings
- [x] 08-owned-audience-identity-flywheel — NOT standalone, 19 xrefs, 13 undefined terms; "warning before the next code block" residue, bullet-dumped theses, stacked videos
- [x] 09-putting-it-all-together — NOT standalone, 40 xrefs (worst density), 11 undefined terms; leans on every other chapter by number

## Phase 2 — Keep/Grow/Run spine

- [x] 06-building-lifecycle-with-hogsend — 43 xrefs (most in course), 16 atoms, playbook chapter
- [x] 05-lifecycle-messaging — 26 xrefs, 9 undefined terms (dunning, holdout, global holdout…)
- [x] 10-your-30-60-90-180-day-plan — 31 xrefs, 8 undefined terms, 15 atoms
- [x] 13-talking-about-growth — 13 xrefs, 8 undefined terms

## Phase 3 — Measure spine + newer chapters

- [x] 11-stages-of-growth — 15 xrefs, 6 undefined terms
- [x] 12-running-experiments — 3 xrefs, 6 undefined terms (cleanest; light pass)
- [x] 14-growth-as-career-capital — 17 xrefs, 4 undefined terms
- [x] 02-aarrr-and-the-leaky-bucket — 17 xrefs, AARRR never expanded as acronym
- [x] 03-instrument-posthog — 15 xrefs, 8 undefined terms
- [x] 04-your-daily-dashboard — 12 xrefs, 4 undefined terms (CAC/MRR/NPS/holdout)

## Phase 4 — Bar chapters (light targeted polish only) + course-wide sweep

- [x] 00-product-led-growth — fix "as Chapter 2 will put it", bare "dunning" before its gloss, "Four failure modes" under a five-mode title, stale numeric refs, term glosses. Do NOT re-voice — this is the bar.
- [x] 01-what-is-posthog — fix 06-workflows-vs-hogsend self-referential opener ("This wouldn't be a Hogsend course without us talking about Hogsend"), expand CDP/NPS/ETL/AARRR, cohort gloss. Do NOT re-voice.
- [x] Course-wide sweep — residue grep returns nothing; remaining cross-refs point by content not bare number (survivors live only inside frozen component strings and resolve in the sidebar); hub mini-glossaries in place on all jargon-heavy chapters; full production build green; render + content assertions pass (324 lesson links on overview)
- [~] Push branch, open PR, Railway preview for Doug (seam: preview review before merge — do not merge)

## Seam asks (running list)

- Doug: review the Railway preview of `feat/course-prose-rewrite`, then say the word to merge. Every chapter was re-audited by a fresh agent to "good/polish-fixed"; all 163 interactive-block persistence keys verified byte-identical against the pre-rewrite baseline.
