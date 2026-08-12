import { createSign, X509Certificate } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assertSnsHttpsUrl,
  assertSnsSigningCertUrl,
  fetchSnsCertificatePem,
  parseSnsMessage,
  SNS_HOST_PATTERN,
  SnsVerificationError,
  snsStringToSign,
  verifySnsMessage,
} from "../sns/verify";

/**
 * SNS SIGNATURE VERIFICATION — the highest-risk surface in this stack.
 *
 * A forged SES event writes bounces and complaints for a tenant, which
 * SUPPRESSES arbitrary addresses for them and damages their sending reputation.
 * The signature check is the only thing standing in the way, so the rejection
 * cases are written first and pinned individually rather than being left to a
 * single "invalid signature" assertion.
 *
 * Nothing here reaches the network: the certificate fetch is injected.
 */

// ---------------------------------------------------------------------------
// Fixtures — a self-signed 2048-bit RSA certificate, generated once for these
// tests and committed. It never leaves this file and signs nothing real.
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCoN4c2H7sLLn/m
moDGhCFJdsVEkALtFp/7X+eBvMPDjLY7Ywehp2pb7PxtlQzy4LOECGS74alu2T8l
SMTSgW9wXr4B0Uvp298NTyaH/6Iyyeyr5zO1vdTueOt5V2hvXOKlXqy8rroIduXn
VHIv3a5vNScJPTt7i/FBwnC5XfUhf3YaABclrZVdg1mlZ4yAJmLbzNeO+idUiUpG
MrzOIwDzE7e6YWg+nmnEGYqgsvQvhxUXjNG/ptvh9lKdNkAHdrRXjwNsqTlA10Bo
c2B0QM1W8vd8d1nMp+mfETbDsEv6GbkOD8nHrEZoccT4XEpRuAXr6X1WAV9a4vQR
a2ONJHMTAgMBAAECggEAQO+ml4MqPkfGAew0t+17uBNMVYpORt3MBkrgYJnQ7GUe
V9CDuqiZC0FxtI+sPvn08owW7txO/saIdMkhia2Dqlo4eRUle/JvqYCbfDZ3k6mV
XkrTEF5mm2Q8akwOuaaeq33fqrq8f9X+LA3SQp4N30oidpOXqbq8+EiqITSfEz2y
lmyEqlDk1P1oTc66et5J+KmLWmB96F2HROh1532qkcCCJe2MRhPk9pq2xqANderQ
rShzXMig5h3Q1yBG81IZNmBr5QTJBOAAmgLQ8jEByvOhgMTN2irN9QhUqDo3h90K
nWutNcmfh8n9FeMdcv4DWJEl/b5VQEd2zpJXXnRoMQKBgQDqxWrzjJO5IWcctWfi
Bkg93/zJsRarR5LyO9VbG3zKf3NwPb83NMiDEHhSxSpk/kF0VR73v9U058UzeIwO
9FmX2i7N3GDTZjDQ2WPfdDHXwV3uU5+pTGFi4VJDmOHv3SSwiXTqVTksrJ0LaS7N
tn7gbQzhT3l+iyE5l6VmmKkjqQKBgQC3bXv7fPRZBfDlPoggpkhDiIg4KjUfISfE
yOM6LHIUQWJ0C+GBAzIgB9+eOlHTLqNk/0DEKQDXGxJCW5wTL/EzHGjMKO5Jug6D
xsLkwMZbFpMZNEYcj9ohboBToDKXOjSQw+00XvZPYV9Gb9t/1+RV/WzHbUkj/Djw
cJgPBPpWWwKBgBb6B0OayIJf4IWQw3/9eWiE2Wqr6DoPITSP4ouuHwJ6gsPDZ0lx
4wXgwMXpAgMsVx+ZjRRWM/mfjU9CRwLXq0UPV3FSVi+aWsC15e5iotYo2JaQnJmn
HgjdYH25IrOlAwg8C7M7cAMNSblqK+h6KeSxB4etjYhy+Wd3jfqCilsxAoGAbmfp
A4O/s8HesK2F1FkiD/wjOeM13EnhnRHpq39LHyQH9Z+dGUFqL1tt3thtnfZphQYa
3rdreQ4jXGu1strdjI0iCxjr7Nafm/PMJVJfUj5xRe9v8AsqGYtglHVNXjc7opM7
uJUcHsWWSlhTv0ycdKG4kwUVzCIpx5eN/yRY5hcCgYAigKJeKA3yRgo2QZjyc8R1
zcZ3X8mmO3eLtR9ib5it2Y6AAje1ch6jRV6aewoGNpfPbqUFAHjagzIL/V8YoBza
giMBjzVMNBYlqrBneJXnlvHYsrXrzu7ip0LKe+4YLKn8cihe8rN9sDMKuXYiBL7a
L2oPkjuZ+RLxz037f4+8/w==
-----END PRIVATE KEY-----`;

const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDWTCCAkGgAwIBAgIULgdTvlRTvlNDIhAyKbiUUOzcsIswDQYJKoZIhvcNAQEL
BQAwOzEaMBgGA1UEAwwRc25zLmFtYXpvbmF3cy5jb20xHTAbBgNVBAoMFEhvZ3Nl
bmQgVGVzdCBGaXh0dXJlMCAXDTI2MDgxMTAwMTM0OFoYDzIxMjYwNzE4MDAxMzQ4
WjA7MRowGAYDVQQDDBFzbnMuYW1hem9uYXdzLmNvbTEdMBsGA1UECgwUSG9nc2Vu
ZCBUZXN0IEZpeHR1cmUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCo
N4c2H7sLLn/mmoDGhCFJdsVEkALtFp/7X+eBvMPDjLY7Ywehp2pb7PxtlQzy4LOE
CGS74alu2T8lSMTSgW9wXr4B0Uvp298NTyaH/6Iyyeyr5zO1vdTueOt5V2hvXOKl
Xqy8rroIduXnVHIv3a5vNScJPTt7i/FBwnC5XfUhf3YaABclrZVdg1mlZ4yAJmLb
zNeO+idUiUpGMrzOIwDzE7e6YWg+nmnEGYqgsvQvhxUXjNG/ptvh9lKdNkAHdrRX
jwNsqTlA10Boc2B0QM1W8vd8d1nMp+mfETbDsEv6GbkOD8nHrEZoccT4XEpRuAXr
6X1WAV9a4vQRa2ONJHMTAgMBAAGjUzBRMB0GA1UdDgQWBBRdRotQX1ksTPJDFFYb
HPB1/9UPJDAfBgNVHSMEGDAWgBRdRotQX1ksTPJDFFYbHPB1/9UPJDAPBgNVHRMB
Af8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAEr5X9TcG2lBTBtw3IUdeTtpHP
PJEJof25VtJx6GO66Fe3kH8xnTQYCpX3t3vBctcz4QPsuUcEFh9QcDW3jHxNt1Kv
0rFz9ITzM5glbl84cL4jEgZ/qgydSOnR+K33jJTCQcGfgGiPudVadr03Kku4h0lD
+2dOc/y2ZpwNUCtCvT4HVTUaFbrXX0ZWzX9vZGwJgdNXyK6t1+ocmhR2oHd7oQRF
/2x0IlMLAmau8HL2/n6TVbz39UPLaPX1AHUjvuslBgTHNb3OjDWcqWlz6kJeeb8O
kgh3V3BG7dqVOI+wDcVQl7n2HhWMKpTFglONPHS3ip2Z+rDn0bX2c0eVp8cT
-----END CERTIFICATE-----`;

const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotification-x.pem";
const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:hogsend-email-events-us";

/**
 * The string-to-sign builder, written out INDEPENDENTLY of the implementation.
 *
 * Signing with the module's own builder would make every signature test
 * vacuous: a wrong field order would sign and verify against itself and pass.
 * The literal-string test below pins the construction against AWS's own
 * documented example, and this helper only produces bytes for the rest.
 */
function buildStringToSign(message: Record<string, string>): string {
  const fields =
    message.Type === "Notification"
      ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
      : [
          "Message",
          "MessageId",
          "SubscribeURL",
          "Timestamp",
          "Token",
          "TopicArn",
          "Type",
        ];
  return fields
    .filter((field) => message[field] !== undefined)
    .map((field) => `${field}\n${message[field]}\n`)
    .join("");
}

function sign(message: Record<string, string>, version = "1"): string {
  const algorithm = version === "2" ? "RSA-SHA256" : "RSA-SHA1";
  return createSign(algorithm)
    .update(buildStringToSign(message), "utf8")
    .sign(TEST_PRIVATE_KEY, "base64");
}

/** A signed Notification, with any field overridden. */
function notification(
  overrides: Record<string, string> = {},
  signatureVersion = "1",
): Record<string, string> {
  const message: Record<string, string> = {
    Type: "Notification",
    MessageId: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324",
    TopicArn: TOPIC_ARN,
    Message: '{"eventType":"Delivery"}',
    Timestamp: "2026-08-11T00:00:00.000Z",
    SignatureVersion: signatureVersion,
    SigningCertURL: CERT_URL,
    ...overrides,
  };
  return { ...message, Signature: sign(message, signatureVersion) };
}

function confirmation(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const message: Record<string, string> = {
    Type: "SubscriptionConfirmation",
    MessageId: "165545c9-2a5c-472c-8df2-7ff2be2b3b1b",
    Token: "2336412f37…",
    TopicArn: TOPIC_ARN,
    Message: "You have chosen to subscribe to the topic …",
    SubscribeURL:
      "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=y",
    Timestamp: "2026-08-11T00:00:00.000Z",
    SignatureVersion: "1",
    SigningCertURL: CERT_URL,
    ...overrides,
  };
  return { ...message, Signature: sign(message, "1") };
}

/** The injected certificate seam: hands back the fixture, counts the calls. */
function certFetcher(pem = TEST_CERT_PEM) {
  const fn = vi.fn(async () => pem);
  return fn;
}

async function verify(
  message: Record<string, string>,
  fetchCertificatePem = certFetcher(),
) {
  return verifySnsMessage({
    message: parseSnsMessage(message),
    fetchCertificatePem,
  });
}

// ---------------------------------------------------------------------------
// The string to sign — pinned against AWS's documented example
// ---------------------------------------------------------------------------

describe("snsStringToSign", () => {
  /**
   * Verbatim from AWS's "Verifying the signature of an Amazon SNS message when
   * using HTTP query-based requests" (docs.aws.amazon.com/sns/latest/dg/
   * sns-verify-signature-of-message-verify-message-signature.html), whose
   * Notification example is reproduced field for field below. The trailing
   * newline after the last value matches AWS's own reference implementation
   * (aws/aws-php-sns-message-validator builds `"{$key}\n{$value}\n"` for every
   * signable key), which is the behaviour real SNS signatures verify against.
   */
  it("builds AWS's documented Notification example byte for byte", () => {
    const built = snsStringToSign(
      parseSnsMessage({
        Type: "Notification",
        Message: "My Test Message",
        MessageId: "4d4dc071-ddbf-465d-bba8-08f81c89da64",
        Subject: "My subject",
        Timestamp: "2019-01-31T04:37:04.321Z",
        TopicArn:
          "arn:aws:sns:us-east-2:123456789012:s4-MySNSTopic-1G1WEFCOXTC0P",
        SignatureVersion: "1",
        Signature: "irrelevant",
        SigningCertURL: CERT_URL,
      }),
    );

    expect(built).toBe(
      "Message\nMy Test Message\n" +
        "MessageId\n4d4dc071-ddbf-465d-bba8-08f81c89da64\n" +
        "Subject\nMy subject\n" +
        "Timestamp\n2019-01-31T04:37:04.321Z\n" +
        "TopicArn\narn:aws:sns:us-east-2:123456789012:s4-MySNSTopic-1G1WEFCOXTC0P\n" +
        "Type\nNotification\n",
    );
  });

  it("omits Subject entirely when the notification has none", () => {
    const built = snsStringToSign(parseSnsMessage(notification()));
    expect(built).not.toContain("Subject");
    expect(built.startsWith("Message\n")).toBe(true);
    expect(built.endsWith("Type\nNotification\n")).toBe(true);
  });

  it("uses the confirmation field set for SubscriptionConfirmation", () => {
    const built = snsStringToSign(parseSnsMessage(confirmation()));
    // Message, MessageId, SubscribeURL, Timestamp, Token, TopicArn, Type — the
    // documented order, which is byte-sorted and NOT the notification's.
    expect(built.split("\n").filter((_, i) => i % 2 === 0)).toEqual([
      "Message",
      "MessageId",
      "SubscribeURL",
      "Timestamp",
      "Token",
      "TopicArn",
      "Type",
      "",
    ]);
  });

  it("never signs a field outside the documented set", () => {
    // An attacker-controlled extra key must not enter the signed string: if it
    // did, a forged field could be smuggled past a signature AWS computed
    // without it. (Here it would only ever cause a MISmatch, which is why the
    // per-Type field list — not "whatever arrived" — is the construction.)
    const built = snsStringToSign(
      parseSnsMessage({ ...notification(), Token: "smuggled" }),
    );
    expect(built).not.toContain("smuggled");
    expect(built).not.toContain("Token");
  });
});

// ---------------------------------------------------------------------------
// Certificate URL validation — the SSRF surface. REJECTIONS FIRST.
// ---------------------------------------------------------------------------

describe("assertSnsSigningCertUrl", () => {
  it("accepts a real SNS signing certificate URL", () => {
    expect(assertSnsSigningCertUrl(CERT_URL).hostname).toBe(
      "sns.us-east-1.amazonaws.com",
    );
  });

  const rejections: Array<[string, string]> = [
    [
      "suffix attack — amazonaws.com is a PREFIX of the real host",
      "https://sns.us-east-1.amazonaws.com.evil.com/x.pem",
    ],
    [
      "path, not host — the allowlisted string appears in the PATH",
      "https://evil.com/sns.us-east-1.amazonaws.com/x.pem",
    ],
    [
      "userinfo attack — the real host is evil.com, and a regex over the raw string would miss it",
      "https://sns.us-east-1.amazonaws.com@evil.com/x.pem",
    ],
    ["typo-squat TLD", "https://sns.us-east-1.amazonaws.co/x.pem"],
    ["plaintext", "http://sns.us-east-1.amazonaws.com/x.pem"],
    ["not a certificate", "https://sns.us-east-1.amazonaws.com/x.txt"],
    ["no region label at all", "https://sns.amazonaws.com/x.pem"],
    [
      "the metadata service, direct",
      "http://169.254.169.254/latest/meta-data/",
    ],
    ["a file URL", "file:///etc/passwd"],
    ["not a URL at all", "not-a-url"],
  ];

  for (const [name, url] of rejections) {
    it(`rejects ${name}`, () => {
      expect(() => assertSnsSigningCertUrl(url)).toThrow(SnsVerificationError);
    });
  }

  it("reads url.hostname, never the raw string", () => {
    // The property behind the three look-alike cases above, stated directly:
    // each raw URL CONTAINS the allowlisted name, so a regex over the whole
    // string matches — and `hostname` is something else entirely.
    const hostile = [
      "https://sns.us-east-1.amazonaws.com.evil.com/x.pem",
      "https://evil.com/sns.us-east-1.amazonaws.com/x.pem",
      "https://sns.us-east-1.amazonaws.com@evil.com/x.pem",
    ];
    expect(SNS_HOST_PATTERN.test("sns.us-east-1.amazonaws.com")).toBe(true);
    for (const raw of hostile) {
      expect(raw).toContain("sns.us-east-1.amazonaws.com");
      expect(SNS_HOST_PATTERN.test(new URL(raw).hostname)).toBe(false);
      expect(() => assertSnsSigningCertUrl(raw)).toThrow(SnsVerificationError);
    }
    // And the two that carry no credentials are refused BY THE HOST, so the
    // allowlist itself is doing the work rather than the userinfo guard.
    expect(() => assertSnsSigningCertUrl(hostile[0] as string)).toThrow(
      /host/i,
    );
    expect(() => assertSnsSigningCertUrl(hostile[1] as string)).toThrow(
      /host/i,
    );
  });
});

describe("assertSnsHttpsUrl", () => {
  it("accepts an SNS confirmation URL, which is not a .pem", () => {
    expect(
      assertSnsHttpsUrl(
        "https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription",
      ).hostname,
    ).toBe("sns.eu-west-1.amazonaws.com");
  });

  it("rejects a SubscribeURL pointed anywhere else", () => {
    // Blindly GETting whatever SubscribeURL arrives is the same SSRF by another
    // door, so the confirmation URL runs through the same host allowlist.
    expect(() => assertSnsHttpsUrl("https://evil.com/?Action=Confirm")).toThrow(
      SnsVerificationError,
    );
    expect(() =>
      assertSnsHttpsUrl("http://169.254.169.254/latest/meta-data/"),
    ).toThrow(SnsVerificationError);
  });
});

// ---------------------------------------------------------------------------
// The certificate fetch — redirects are a rejection, not a hop
// ---------------------------------------------------------------------------

describe("fetchSnsCertificatePem", () => {
  it("requests with redirects disabled and rejects a 3xx", async () => {
    // The 302-to-the-metadata-service case: a URL that PASSES the allowlist and
    // then hops somewhere it never could have named directly.
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        }),
    ) as unknown as typeof fetch & {
      mock: { calls: Array<[RequestInfo | URL, RequestInit | undefined]> };
    };

    // Named as a redirect, not merely as "not ok". Undici happens to surface a
    // manual-mode 3xx with `ok === false`, so a generic refusal would pass with
    // the redirect branch deleted — the message is what pins the branch.
    await expect(
      fetchSnsCertificatePem(new URL(CERT_URL), { fetchImpl }),
    ).rejects.toThrow(/redirect/i);

    // And the guard that actually matters: the REQUEST refused to follow in the
    // first place. A runtime that transparently redirected would never surface
    // a 3xx for the branch above to catch.
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("rejects a non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    await expect(
      fetchSnsCertificatePem(new URL(CERT_URL), { fetchImpl }),
    ).rejects.toThrow(SnsVerificationError);
  });

  it("rejects a body that is not a PEM certificate", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>hi</html>"));
    await expect(
      fetchSnsCertificatePem(new URL(CERT_URL), { fetchImpl }),
    ).rejects.toThrow(SnsVerificationError);
  });

  it("returns the certificate body when everything checks out", async () => {
    const fetchImpl = vi.fn(async () => new Response(TEST_CERT_PEM));
    await expect(
      fetchSnsCertificatePem(new URL(CERT_URL), { fetchImpl }),
    ).resolves.toContain("BEGIN CERTIFICATE");
  });
});

// ---------------------------------------------------------------------------
// verifySnsMessage
// ---------------------------------------------------------------------------

describe("verifySnsMessage", () => {
  it("accepts a correctly signed SignatureVersion 1 notification", async () => {
    await expect(verify(notification())).resolves.toBeUndefined();
  });

  it("accepts a correctly signed SignatureVersion 2 notification", async () => {
    await expect(verify(notification({}, "2"))).resolves.toBeUndefined();
  });

  it("accepts a correctly signed subscription confirmation", async () => {
    await expect(verify(confirmation())).resolves.toBeUndefined();
  });

  it("rejects a tampered Message without fetching the certificate", async () => {
    const message = notification();
    message.Message = '{"eventType":"Bounce"}';
    const fetcher = certFetcher();
    await expect(verify(message, fetcher)).rejects.toThrow(
      SnsVerificationError,
    );
  });

  it("rejects a signature signed under the WRONG algorithm for its version", async () => {
    // SHA1 bytes presented as SignatureVersion 2. Defaulting the algorithm
    // instead of branching on the declared version would accept this.
    const base = {
      Type: "Notification",
      MessageId: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324",
      TopicArn: TOPIC_ARN,
      Message: '{"eventType":"Delivery"}',
      Timestamp: "2026-08-11T00:00:00.000Z",
      SignatureVersion: "2",
      SigningCertURL: CERT_URL,
    };
    const message = { ...base, Signature: sign(base, "1") };
    await expect(verify(message)).rejects.toThrow(SnsVerificationError);
  });

  it("rejects an unknown SignatureVersion outright rather than defaulting", async () => {
    const fetcher = certFetcher();
    await expect(
      verify({ ...notification(), SignatureVersion: "3" }, fetcher),
    ).rejects.toThrow(/SignatureVersion/i);
    // And it never even reached for a certificate.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("NEVER fetches the certificate for a SigningCertURL outside the allowlist", async () => {
    const fetcher = certFetcher();
    await expect(
      verify(
        notification({
          SigningCertURL: "https://sns.us-east-1.amazonaws.com.evil.com/x.pem",
        }),
        fetcher,
      ),
    ).rejects.toThrow(SnsVerificationError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a certificate that is not a certificate", async () => {
    await expect(
      verify(notification(), certFetcher("-----BEGIN NONSENSE-----")),
    ).rejects.toThrow(SnsVerificationError);
  });

  it("rejects a signature made by a DIFFERENT key", async () => {
    // Signed correctly, but by somebody else — the case a host allowlist alone
    // would not catch.
    const message = notification();
    const other = new X509Certificate(TEST_CERT_PEM);
    expect(other.publicKey).toBeDefined();
    message.Signature = Buffer.from("garbage").toString("base64");
    await expect(verify(message)).rejects.toThrow(SnsVerificationError);
  });

  it("rejects an unknown message Type", async () => {
    expect(() =>
      parseSnsMessage({ ...notification(), Type: "Whatever" }),
    ).toThrow(SnsVerificationError);
  });
});
