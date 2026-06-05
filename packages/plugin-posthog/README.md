# @hogsend/plugin-posthog

PostHog integration for [Hogsend](https://github.com/dougwithseismic/hogsend):
person-property fetching with optional Redis caching, and event capture.

`createPostHogService` is the **reference implementation** of the `PostHogService`
contract — the contract itself (with `CaptureOptions`) lives in `@hogsend/core`
(canonical author import `@hogsend/engine`); this package re-exports them for
back-compat. To swap analytics, implement that interface. See
[docs/adr/0001-provider-boundary.md](https://github.com/dougwithseismic/hogsend/blob/main/docs/adr/0001-provider-boundary.md).

This package ships raw TypeScript source; consumers bundle it via their own build
(tsup `noExternal`). See the
[release model](https://github.com/dougwithseismic/hogsend/blob/main/docs/RELEASING.md).
