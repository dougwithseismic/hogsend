/**
 * Walk the WHOLE SES contract against a REAL AWS account and report every place
 * AWS disagrees with `FakeSesClient` (PRD 11).
 *
 *   pnpm --filter @hogsend/cloud ses:walkthrough -- --help
 *   CLOUD_AWS_ACCESS_KEY_ID=… CLOUD_AWS_SECRET_ACCESS_KEY=… \
 *     pnpm --filter @hogsend/cloud ses:walkthrough -- --i-know-this-hits-aws
 *
 * ## Read this before running it
 *
 * This is NOT a test. It creates and deletes real, billable, stateful AWS
 * resources — a tenant, a configuration set, an email identity — and it burns
 * the account's SES throttle while it runs. It refuses by default, three ways:
 * without `--i-know-this-hits-aws`, without BOTH credential variables, and
 * against any account that already holds an SES tenant it did not create.
 *
 * ## Why it exists
 *
 * Every test covering Hogsend Email runs against `FakeSesClient` or an injected
 * transport. Not one of them has reached AWS. PRD 02 shipped 1089 tests green
 * while carrying a real cross-tenant suppression leak, because the contract,
 * the implementation, the Fake and the tests all agreed with each other and all
 * four were wrong together. This script is the thing that breaks that circle:
 * it asks AWS, and prints the difference.
 *
 * ## The two optional legs
 *
 * `--sns-topic-arn` exercises the event destination; `--send-from` +
 * `--send-to` exercise the two send verbs (in SES sandbox BOTH addresses must
 * already be verified identities). Without them those verbs are reported as
 * SKIPPED with the reason, never quietly passed over — a verb nobody exercised
 * is a verb whose Fake is still unproven.
 */
import { runWalkthrough } from "./src/ses-walkthrough/index";

// No top-level await: `apps/cloud` is not `"type": "module"`, so tsx compiles
// this to CJS and a top-level await is a transform error rather than a runtime
// one — it would fail before a single guard ran.
runWalkthrough(process.argv.slice(2))
  .then((result) => {
    process.exit(result.exitCode);
  })
  .catch((error: unknown) => {
    // Anything that escaped the runner. The runner already tears down what it
    // created; this is the last resort, and it must still exit non-zero.
    process.stderr.write(
      `✗ ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
