import type { TemplateName } from "@hogsend/email";
import type { SmsTemplateName } from "@hogsend/sms";

/**
 * Closes the loop between the WRITE path and the READ path for template keys.
 *
 * `@hogsend/core` declares `ctx.history.email({ template })` against an empty
 * carrier interface because it cannot depend on `@hogsend/email` without
 * inverting the package layering. The engine already depends on both, so it is
 * the one layer that can supply the answer.
 *
 * This lives in its own module — rather than beside the `JourneyContext`
 * implementation — because a module augmentation only applies to programs that
 * actually LOAD the file declaring it, and `journey-context.ts` is not
 * reachable from the two entry points consumers author and test journeys
 * through (`@hogsend/engine/journeys` and `@hogsend/engine/testing`). A journey
 * package that imports only those entries would have silently reverted to an
 * unchecked `string`, which is the exact defect the narrowing exists to remove.
 * Every entry point that can hand out a `JourneyContext` therefore side-effect
 * imports this module, and `entry-augmentation.test.ts` fails if one stops.
 *
 * `TemplateName`/`SmsTemplateName` are `never` until the consumer augments the
 * registries; `EmailTemplateKey`/`SmsTemplateKey` widen `never` back to `string`
 * so a scaffold with no templates yet still compiles.
 */
declare module "@hogsend/core/types" {
  interface EmailTemplateKeyCarrier {
    key: TemplateName;
  }
  interface SmsTemplateKeyCarrier {
    key: SmsTemplateName;
  }
}
