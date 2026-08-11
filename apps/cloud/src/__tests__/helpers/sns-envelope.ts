import { createSign } from "node:crypto";

/**
 * A REAL, signed SNS envelope, for any suite that has to reach an SNS ingress.
 *
 * The signer here is written out INDEPENDENTLY of `src/sns/verify.ts` - the
 * field list below is transcribed from AWS's documentation, not imported from
 * the implementation - so a wrong field order in `snsStringToSign` cannot sign
 * and verify against itself. That property is the whole reason the fixture is a
 * real RSA signature over a real certificate rather than a stub verifier.
 *
 * The keypair is a throwaway generated for the test suite. It is committed on
 * purpose: a certificate generated at test time would need a self-signed X.509
 * builder Node does not ship, and the cert's only job is to carry a public key
 * the suite already knows the private half of.
 */

export const SNS_TEST_CERT_URL =
  "https://sns.us-east-1.amazonaws.com/SimpleNotification-x.pem";

export const SNS_TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
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

export const SNS_TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
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

/** AWS's documented signed field set, per message type, transcribed by hand. */
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

let envelopeSeq = 0;

/** A signed SNS envelope. `sign: false` produces a plausible-looking forgery. */
export function snsEnvelope(
  fields: Record<string, string>,
  opts: { topicArn: string; sign?: boolean },
): Record<string, string> {
  envelopeSeq += 1;
  const message: Record<string, string> = {
    MessageId: `sns-message-${envelopeSeq}`,
    TopicArn: opts.topicArn,
    Timestamp: "2026-08-11T00:00:00.000Z",
    SignatureVersion: "1",
    SigningCertURL: SNS_TEST_CERT_URL,
    ...fields,
  };
  const signature =
    opts.sign === false
      ? "bm90LWEtc2lnbmF0dXJl"
      : createSign("RSA-SHA1")
          .update(buildStringToSign(message), "utf8")
          .sign(SNS_TEST_PRIVATE_KEY, "base64");
  return { ...message, Signature: signature };
}

/** A signed `Notification` carrying `payload` as its `Message` string. */
export function snsNotification(
  payload: unknown,
  opts: {
    topicArn: string;
    sign?: boolean;
    overrides?: Record<string, string>;
  },
): Record<string, string> {
  return snsEnvelope(
    {
      Type: "Notification",
      Message: JSON.stringify(payload),
      ...opts.overrides,
    },
    opts,
  );
}
