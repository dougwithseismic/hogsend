#!/usr/bin/env node
// Bare-name alias: `hogsend` → @hogsend/cli's real bin (its "./bin" export);
// argv passes through untouched.
await import("@hogsend/cli/bin");
