---
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-twilio": minor
"@hogsend/plugin-apollo": minor
"@hogsend/engine": minor
"@hogsend/sms": minor
"create-hogsend": minor
---

Make the opt-in provider plugins actually loadable at runtime.

The Apollo, Postmark and Twilio env presets could never work in a bundled
consumer — which is every scaffolded app. Setting `APOLLO_API_KEY`,
`POSTMARK_SERVER_TOKEN` or the Twilio credentials registered nothing, and the
feature silently did nothing while the deploy looked healthy.

Each plugin is reached through a guarded dynamic import whose specifier is
assembled at runtime so `tsc` will not resolve it for consumers without the
package. That also hides it from the bundler, so Node loads the package from
`node_modules` at run time — and all three published raw `src/` as their runtime
entry, where Node refuses to strip types.

Two failures stacked. Apollo, as a direct dependency, resolved and then died on
type stripping. Postmark and Twilio are engine `optionalDependencies`, which
pnpm installs under `.pnpm/` but never links at the consumer's top level, so
they failed to resolve at all — the import runs from the consumer's bundle, not
the engine's.

**The plugins now ship a built `dist/` as their runtime entry.** `types` still
points at raw `src/`, so nothing changes for type-checking. `@hogsend/sms` gains
a `./types` subpath export, which `plugin-twilio` uses for `SmsSendError`
instead of the package barrel — that barrel was pulling the entire react-email
render stack into the plugin bundle, 1.6 MB for one error class, now 8 KB.

**Failure messages now tell the truth.** One shared loader replaces three
divergent `catch` blocks: the enrichment one reported every failure as "is not
installed" including when the package was installed, so the fix it prescribed
could not work, and the SMS one logged nothing at all. Failures are classified
as not-installed, load-failed or missing-export, and classification inspects the
error message rather than the code alone — otherwise a plugin's own missing
dependency gets reported as the plugin being absent.

**`create-hogsend` gains `--with apollo|postmark|twilio`** (repeatable and
comma-separated) plus an interactive multiselect. Selecting one pins the plugin
as a direct dependency of the generated app and surfaces its credential block in
`.env.example`. Nothing is wired in code: the engine's env preset registers the
provider once the package is present and the credential is set.

**Upgrading:** if you set one of these credentials, add the matching package to
your app — `pnpm add @hogsend/plugin-apollo` (or `-postmark` / `-twilio`). It
must be a direct dependency; the engine's `optionalDependencies` entry is not
enough, because your app bundles the engine and the import resolves against your
`node_modules`. The boot log now names this precisely when it happens.

`release-doctor` fails if an opt-in plugin's runtime entry is raw TypeScript,
and the scaffold verifier now loads the plugin from a built app under plain
`node`, so this cannot regress silently.
