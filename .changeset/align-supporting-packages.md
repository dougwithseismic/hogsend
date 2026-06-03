---
"@hogsend/email": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
---

Align the supporting packages to the 0.1.0 release line. A scaffolded app pins every `@hogsend/*` dependency to a single exact version token, so all published packages must share one version line. These three lagged at 0.0.1 while the engine line moved to 0.1.0, which would leave a fresh scaffold unable to resolve its dependencies.
