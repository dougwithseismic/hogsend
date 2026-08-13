---
"create-hogsend": patch
---

A scaffolded app can now actually lint itself. The template shipped Biome as a
dependency and a complete `biome.json`, but no `lint` script — so `pnpm lint`
fell through to `PATH` and ran whatever unrelated `lint` binary the machine had
(on a Mac with the Android SDK installed, that is the Android static analyzer,
which fails looking for a JVM). Adds `lint`, `lint:fix` and `format`, matching
the engine repo's script names. A fresh scaffold passes `biome check` clean.
