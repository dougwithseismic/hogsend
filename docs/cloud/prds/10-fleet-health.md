# PRD 10 — Fleet health + operator console (scoped; flesh out when popped)

## Scope
Our side of the fence: an operator-only console (role `platform_admin`, allowlisted by
email env var) showing every org/stack, health rollups from `stack_health`, error stacks,
stuck-provision detection, build failures, usage outliers; per-stack suspend/resume
(abuse switch) and a re-provision action; a daily digest task (log-only until a Slack/
email seam is granted). Customer-facing status surface stays the PRD 04 environment page.

Key invariants: operator console is unreachable by customer roles (route-guard tests);
every operator action is audit-logged with actor.

_Boundary:_ `apps/cloud`. _Depends:_ PRD 04 (06 for usage panels).

## Implementation Notes
