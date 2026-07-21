// Module augmentation — this is what makes every `group:` option
// (`ctx.waitForEvent` / `ctx.history.hasEvent`) fully type-checked against
// YOUR group types: augmenting `GroupTypeMap` narrows `GroupType` from plain
// `string` to your declared keys, so typos are rejected at compile time.
// Uncomment and list your group types once you start using groups:
//
// declare module "@hogsend/core" {
//   interface GroupTypeMap {
//     company: true;
//   }
// }
