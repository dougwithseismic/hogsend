---
"@hogsend/cli": minor
"@hogsend/mcp": minor
"create-hogsend": minor
---

Seamless cloud: `hogsend signup` / `hogsend login --email` (email-OTP sign-in,
no browser needed), self-healing `hogsend publish` (offers sign-in inline,
narrates first-publish provisioning, `--no-wait` prints the build id off-TTY),
`create-hogsend --cloud` (scaffold to a live hosted instance in one command),
the `@hogsend/cli/cloud` library entry, and five `cloud_*` MCP tools in
`@hogsend/mcp`'s stdio server (signup/verify/whoami/publish/build_status;
admin key now optional — without it the instance tools are absent and the
cloud tools work).
