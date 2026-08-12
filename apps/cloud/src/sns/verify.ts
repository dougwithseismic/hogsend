import { createVerify, type KeyObject, X509Certificate } from "node:crypto";
import { z } from "zod";

/**
 * SNS MESSAGE AUTHENTICATION.
 *
 * This module is the only thing standing between an anonymous HTTP POST and a
 * tenant's suppression list. A forged SES event writes bounces and complaints
 * for an environment, which suppresses arbitrary addresses for that customer
 * and damages their sending reputation — so every rule below is written out
 * rather than left to a library's defaults, and each one has a rejection test.
 *
 * Three separate defences, in this order:
 *
 *  1. **The `SigningCertURL` is validated BEFORE it is fetched.** An
 *     unvalidated certificate URL is a straightforward SSRF: the attacker names
 *     a host, we make an outbound request to it from inside the control plane,
 *     and we then trust whatever key comes back. The allowlist reads
 *     `url.hostname` and NEVER the raw string — `https://sns.us-east-1.
 *     amazonaws.com@evil.com/x.pem` contains the allowlisted host as USERINFO
 *     and resolves to `evil.com`, so a regex over the whole URL matches it and
 *     a `hostname` check does not.
 *  2. **The fetch does not follow redirects.** A 3xx is a rejection, not a hop.
 *     Otherwise a URL that passes the allowlist can bounce to
 *     `http://169.254.169.254/…` and the allowlist has bought nothing.
 *  3. **The signed string is BUILT from AWS's documented field set**, per
 *     message `Type`, rather than serialized from whatever JSON arrived. An
 *     extra attacker-supplied key can therefore never enter the signed bytes.
 *
 * Verified 2026-08-11 against AWS's own documentation — "Verifying the
 * signature of an Amazon SNS message when using HTTP query-based requests",
 * https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message-verify-message-signature.html
 * — and cross-checked against AWS's reference implementation,
 * `aws/aws-php-sns-message-validator`, for the one detail the prose leaves
 * ambiguous (the trailing newline; see {@link snsStringToSign}).
 *
 * We do NOT chain-validate the signing certificate against a CA bundle. The
 * trust comes from the transport: the PEM is fetched over HTTPS from a host
 * this module allowlisted, with redirects refused, so TLS has already
 * authenticated the origin as AWS. AWS's own PHP validator makes the same
 * choice.
 */

/** The only reasons this module refuses a message. Callers branch on these. */
export type SnsVerificationReason =
  | "malformed"
  | "cert_url"
  | "cert_fetch"
  | "cert_invalid"
  | "signature_version"
  | "signature";

export class SnsVerificationError extends Error {
  readonly reason: SnsVerificationReason;

  constructor(message: string, reason: SnsVerificationReason) {
    super(message);
    this.name = "SnsVerificationError";
    this.reason = reason;
  }
}

/**
 * The SNS endpoint hosts, and nothing else.
 *
 * Anchored at both ends and matched against `url.hostname`, so
 * `sns.us-east-1.amazonaws.com.evil.com` fails on the trailing `.evil.com` and
 * `evil.com/sns.us-east-1.amazonaws.com/…` never gets as far as being a host.
 *
 * Deliberately NARROWER than AWS's own reference regex, which also admits
 * `.amazonaws.com.cn`: this control plane provisions into `us-east-1` and
 * `eu-west-1` only (DECISIONS §3.3), so a China-partition certificate URL is
 * not a case we serve and admitting it would widen the allowlist for nothing.
 * A region label is REQUIRED — bare `sns.amazonaws.com` is not an endpoint.
 */
export const SNS_HOST_PATTERN = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

/**
 * The SNS envelope. NOT strict: SNS adds fields (`UnsubscribeURL`,
 * `SigningCertUrl` in older casings) and a control plane that 400'd on a new
 * one would break on an AWS release. Only the fields named here are ever read,
 * and only the documented subset is ever signed.
 */
const snsMessageSchema = z.object({
  Type: z.enum([
    "Notification",
    "SubscriptionConfirmation",
    "UnsubscribeConfirmation",
  ]),
  MessageId: z.string().min(1),
  TopicArn: z.string().min(1),
  Message: z.string(),
  Timestamp: z.string().min(1),
  SignatureVersion: z.string().min(1),
  Signature: z.string().min(1),
  SigningCertURL: z.string().min(1),
  Subject: z.string().optional(),
  Token: z.string().optional(),
  SubscribeURL: z.string().optional(),
  UnsubscribeURL: z.string().optional(),
});

export type SnsMessage = z.infer<typeof snsMessageSchema>;
export type SnsMessageType = SnsMessage["Type"];

/**
 * Parse the envelope, or refuse.
 *
 * An unknown `Type` is a refusal rather than a pass-through: the signed field
 * set is chosen BY type, so a type we do not know is a message we cannot
 * authenticate.
 */
export function parseSnsMessage(payload: unknown): SnsMessage {
  const parsed = snsMessageSchema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SnsVerificationError(
      `not an SNS message (${
        issue
          ? `${issue.path.join(".") || "payload"}: ${issue.message}`
          : "unrecognized shape"
      })`,
      "malformed",
    );
  }
  return parsed.data;
}

/**
 * The fields AWS signs, per message type, in AWS's documented (byte-sorted)
 * order. Optional entries are included ONLY when present in the message.
 */
const SIGNED_FIELDS: Record<SnsMessageType, readonly (keyof SnsMessage)[]> = {
  Notification: [
    "Message",
    "MessageId",
    "Subject",
    "Timestamp",
    "TopicArn",
    "Type",
  ],
  SubscriptionConfirmation: [
    "Message",
    "MessageId",
    "SubscribeURL",
    "Timestamp",
    "Token",
    "TopicArn",
    "Type",
  ],
  UnsubscribeConfirmation: [
    "Message",
    "MessageId",
    "SubscribeURL",
    "Timestamp",
    "Token",
    "TopicArn",
    "Type",
  ],
};

/**
 * `key\nvalue\n` for each signed field, concatenated in the documented order.
 *
 * Built from {@link SIGNED_FIELDS} rather than from the parsed JSON's own keys,
 * which is the whole security property: a field an attacker adds has no path
 * into the signed bytes.
 *
 * **On the trailing newline.** AWS's prose says "Do not add a newline character
 * at the end of the string", and then its own example script appends `\n` after
 * every field but the last and pipes the result through `echo -e`, which adds
 * one back. The unambiguous authority is AWS's reference implementation
 * (`aws/aws-php-sns-message-validator`), which builds `"{$key}\n{$value}\n"`
 * for every signable key — trailing newline included. That is what real SNS
 * signatures verify against, so it is what this builds.
 */
export function snsStringToSign(message: SnsMessage): string {
  let out = "";
  for (const field of SIGNED_FIELDS[message.Type]) {
    const value = message[field];
    if (value === undefined) continue;
    out += `${field}\n${value}\n`;
  }
  return out;
}

/** Shared URL rules: a real `https:` URL, on an SNS host, with no credentials. */
function assertSnsUrl(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SnsVerificationError(`${label} is not a URL`, "cert_url");
  }

  if (url.protocol !== "https:") {
    throw new SnsVerificationError(
      `${label} must be https, got ${url.protocol}`,
      "cert_url",
    );
  }
  // Credentials in the URL are the userinfo attack's calling card. `hostname`
  // already defeats it, so this is belt and braces — and it makes a hostile URL
  // fail with a reason that names what was actually attempted.
  if (url.username !== "" || url.password !== "") {
    throw new SnsVerificationError(
      `${label} must not carry credentials`,
      "cert_url",
    );
  }
  // `hostname`, NEVER the raw string: `https://sns.us-east-1.amazonaws.com@evil.com/x.pem`
  // has the allowlisted name as USERINFO and a real host of `evil.com`.
  if (!SNS_HOST_PATTERN.test(url.hostname)) {
    throw new SnsVerificationError(
      `${label} host ${JSON.stringify(url.hostname)} is not an AWS SNS endpoint`,
      "cert_url",
    );
  }
  return url;
}

/**
 * The `SigningCertURL` guard. Everything {@link assertSnsUrl} enforces, plus a
 * `.pem` path — a certificate URL that is not a certificate is a redirector.
 */
export function assertSnsSigningCertUrl(raw: string): URL {
  const url = assertSnsUrl(raw, "SigningCertURL");
  if (!url.pathname.endsWith(".pem")) {
    throw new SnsVerificationError(
      `SigningCertURL path ${JSON.stringify(url.pathname)} is not a .pem`,
      "cert_url",
    );
  }
  return url;
}

/**
 * The `SubscribeURL` guard — same host allowlist, no `.pem` rule.
 *
 * Confirming a subscription means making a GET to a URL that arrived in the
 * request body. Doing that unvalidated is the same SSRF as the certificate
 * fetch, by another door, so it runs through the same allowlist.
 */
export function assertSnsHttpsUrl(raw: string): URL {
  return assertSnsUrl(raw, "URL");
}

/** How the certificate is retrieved. Injected everywhere, so no test dials AWS. */
export type SnsCertificateFetcher = (url: URL) => Promise<string>;

/**
 * Fetch the signing certificate with redirects DISABLED.
 *
 * `redirect: "manual"` and an explicit 3xx refusal, because a followed redirect
 * makes the host allowlist decorative: the attacker names an allowlisted URL
 * that 302s to `http://169.254.169.254/…` and the fetch happily goes there.
 */
export async function fetchSnsCertificatePem(
  url: URL,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
  } catch (error) {
    throw new SnsVerificationError(
      `could not fetch the SNS signing certificate: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "cert_fetch",
    );
  }

  // A redirect is a REJECTION. `redirect: "manual"` surfaces it as a normal
  // response (or, in some runtimes, an opaque one) rather than following it.
  if (response.status >= 300 && response.status < 400) {
    throw new SnsVerificationError(
      `the SNS signing certificate URL redirected (${response.status}); redirects are not followed`,
      "cert_fetch",
    );
  }
  if (!response.ok) {
    throw new SnsVerificationError(
      `the SNS signing certificate URL answered ${response.status}`,
      "cert_fetch",
    );
  }

  const pem = await response.text();
  if (!pem.includes("BEGIN CERTIFICATE")) {
    throw new SnsVerificationError(
      "the SNS signing certificate URL did not return a PEM certificate",
      "cert_invalid",
    );
  }
  return pem;
}

/** SNS's two signature versions, and no third. */
const SIGNATURE_ALGORITHMS: Record<string, string> = {
  "1": "RSA-SHA1",
  "2": "RSA-SHA256",
};

/**
 * Verify a parsed SNS message. Resolves on success, throws
 * {@link SnsVerificationError} on any failure.
 *
 * The order matters: `SignatureVersion` is checked BEFORE the certificate is
 * fetched, so a message we could never verify costs no outbound request, and
 * the URL is validated before that.
 */
export async function verifySnsMessage(opts: {
  message: SnsMessage;
  fetchCertificatePem: SnsCertificateFetcher;
}): Promise<void> {
  const { message } = opts;

  const algorithm = SIGNATURE_ALGORITHMS[message.SignatureVersion];
  // REJECTED outright, never defaulted. Defaulting to SHA1 would let an
  // attacker downgrade by naming a version we do not know, and defaulting to
  // SHA256 would silently drop every legitimate version-1 message.
  if (!algorithm) {
    throw new SnsVerificationError(
      `unsupported SNS SignatureVersion ${JSON.stringify(
        message.SignatureVersion,
      )} — only 1 (SHA1) and 2 (SHA256) exist`,
      "signature_version",
    );
  }

  const certUrl = assertSnsSigningCertUrl(message.SigningCertURL);
  const pem = await opts.fetchCertificatePem(certUrl);

  let publicKey: KeyObject;
  try {
    publicKey = new X509Certificate(pem).publicKey;
  } catch (error) {
    throw new SnsVerificationError(
      `the SNS signing certificate could not be parsed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "cert_invalid",
    );
  }

  let valid = false;
  try {
    valid = createVerify(algorithm)
      .update(snsStringToSign(message), "utf8")
      .verify(publicKey, message.Signature, "base64");
  } catch {
    // A malformed base64 signature throws rather than returning false. It is
    // still just an invalid signature.
    valid = false;
  }

  if (!valid) {
    throw new SnsVerificationError(
      "SNS message signature verification failed",
      "signature",
    );
  }
}
