// Module augmentation — this is what makes every `group:` option
// (`ctx.waitForEvent` / `ctx.history.hasEvent`) fully type-checked against
// YOUR group types: augmenting `GroupTypeMap` narrows `GroupType` from plain
// `string` to your declared keys, so typos are rejected at compile time.
//
// The bare import below is REQUIRED: it makes this file a module, so the
// `declare module` block MERGES into `@hogsend/core`. Without it the file is
// a script and the block would REPLACE the package's types wholesale (every
// `@hogsend/core` import in the app would stop resolving).
import "@hogsend/core";

declare module "@hogsend/core" {
  interface GroupTypeMap {
    // `company` drives the bundled `test-group-wait` smoke journey. Add your
    // own group types (team, workspace, account, …) as you use them.
    company: true;
  }
}
