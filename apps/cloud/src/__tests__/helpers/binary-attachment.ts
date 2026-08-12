/**
 * A deliberately BINARY attachment payload, for every suite that asserts a
 * file survives the SES seam.
 *
 * It is a shared fixture rather than three ad-hoc byte arrays because the
 * property that makes it worth anything is easy to lose by accident: an
 * ALL-ASCII payload passes whether or not the send path declares a transfer
 * encoding, so an ASCII fixture certifies nothing. That is precisely how this
 * repo's attachment tests stayed green while real SES replaced every byte
 * above 127 with U+FFFD — measured 2026-08-12, 4096 replacements on an
 * 8212-byte payload, an exact match for that payload's non-ASCII byte count.
 *
 * So: every byte value 0-255 exactly once, then CRLF, NUL, CRLF — the
 * sequences a text-mode pipeline is most likely to rewrite, present as
 * SEQUENCES and not only as individual values. 128 of the 261 bytes are above
 * 127, pinned by {@link BINARY_FIXTURE_NON_ASCII} so a later edit cannot
 * quietly sand the fixture back down to ASCII and take the assertions with it.
 */
export const BINARY_FIXTURE: Uint8Array = (() => {
  /** CRLF, NUL, CRLF. */
  const tail = [0x0d, 0x0a, 0x00, 0x0d, 0x0a];
  const bytes = new Uint8Array(256 + tail.length);
  for (let value = 0; value < 256; value += 1) bytes[value] = value;
  bytes.set(tail, 256);
  return bytes;
})();

/** The same payload in the `{ base64 }` content form the relay always uses. */
export const BINARY_FIXTURE_BASE64 =
  Buffer.from(BINARY_FIXTURE).toString("base64");

/** How many of {@link BINARY_FIXTURE}'s bytes are above 127 — bytes 128-255. */
export const BINARY_FIXTURE_NON_ASCII = 128;

/** Bytes above 127: the ones a 7-bit text pipeline destroys. */
export function countNonAscii(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) if (byte > 0x7f) count += 1;
  return count;
}
