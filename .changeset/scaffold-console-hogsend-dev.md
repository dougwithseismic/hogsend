---
"create-hogsend": patch
---

Teach `hogsend dev` in the scaffolder's console output. The printed next-steps
(interactive note + non-TTY block) and the template bootstrap's closing "✓ Ready."
summary now lead with the one-terminal `hogsend dev` daily driver instead of the
manual two-terminal `dev` + `worker:dev` pair, matching the scaffolded README and
the docs. The template CLAUDE.md commands block lists `hogsend dev` first, with
the manual pair marked as such.
