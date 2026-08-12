/**
 * Prove the WHOLE delivery path against real AWS (PRD 19 tasks 3–4): real
 * sends to the SES mailbox simulator, and each event watched travelling
 * SES → SNS → the local control plane → the signed instance hop → a terminal
 * `email_events` status.
 *
 *   pnpm --filter @hogsend/cloud ses:delivery-proof -- --help
 *   CLOUD_AWS_ACCESS_KEY_ID=… CLOUD_AWS_SECRET_ACCESS_KEY=… \
 *     pnpm --filter @hogsend/cloud ses:delivery-proof -- \
 *       --i-know-this-hits-aws \
 *       --public-url https://<something>.trycloudflare.com \
 *       --send-from ses-proof@hogsend.com
 *
 * ## Read this before running it
 *
 * This is NOT a test. It sends REAL email (simulator addresses only — there is
 * no flag that can aim it anywhere else), creates and deletes real SES
 * resources, subscribes and unsubscribes a real SNS endpoint, and registers
 * run-scoped rows in the control-plane database. It refuses by default:
 * without `--i-know-this-hits-aws`, without BOTH credential variables, without
 * an https `--public-url`, without a verified `--send-from`, without a topic,
 * and against any account holding an SES tenant it did not create.
 *
 * ## Before running
 *
 *  1. `pnpm --filter @hogsend/cloud dev` — the control plane, on :3004, with
 *     the region's CLOUD_SES_SNS_TOPIC_ARN_* exported;
 *  2. `cloudflared tunnel --url http://localhost:3004` — pass the printed
 *     https URL as `--public-url` (started separately ON PURPOSE, so the
 *     tunnel outlives a failed run and stays debuggable);
 *  3. export the SAME CLOUD_DATABASE_URL / CLOUD_ENCRYPTION_SECRET the
 *     control plane uses — this script writes rows it must read back.
 *
 * Run it SPARINGLY (PRD 11's operational warning): bursts of send activity
 * from a young account are the shape that draws an AWS account review.
 */
import { runDeliveryProof } from "../src/ses-delivery-proof/index";

// No top-level await: `apps/cloud` is not `"type": "module"`, so tsx compiles
// this to CJS and a top-level await is a transform error rather than a runtime
// one — it would fail before a single guard ran.
runDeliveryProof(process.argv.slice(2))
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
