---
"@hogsend/engine": minor
"@hogsend/email": minor
"@hogsend/core": minor
"@hogsend/db": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/js": minor
"@hogsend/react": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-discord": minor
"@hogsend/plugin-telegram": minor
"@hogsend/studio": minor
"hogsend": minor
"create-hogsend": minor
---

Fail the build on unregistered journey email template keys.

`sendEmail`'s `template` is now typed against the registered-key union
(`TemplateName`) instead of `string`, so a journey referencing an email template
that was never registered is a compile error at every send site. As a runtime
backstop, `@hogsend/email`'s `getTemplate` / `getTemplateDefinition` /
`getPreviewText` throw a loud, actionable error naming the bad key and the
registered ones (an own-property check, so inherited `Object.prototype` keys
can't slip through). Fixes the class of bug where a journey could point at a
template that doesn't exist and only fail when a real send ran.
