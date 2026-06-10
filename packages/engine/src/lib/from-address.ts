/**
 * From-address helpers. A configured from address may be a bare addr-spec
 * ("doug@hogsend.com") or carry a display name ("Doug at Hogsend
 * <doug@hogsend.com>") — both are valid on the wire for every supported
 * provider. These helpers parse either form so env validation and
 * domain derivation agree on what the address part is.
 */

const ADDR_SPEC_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Extract the addr-spec from a from address ("Doug <d@x.com>" → "d@x.com",
 * "d@x.com" → "d@x.com"). Returns null when no valid address is present.
 */
export function addrSpecOf(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.trim().match(/^[^<>]*<([^<>]+)>$/);
  const addr = (match?.[1] ?? value).trim();
  return ADDR_SPEC_RE.test(addr) ? addr.toLowerCase() : null;
}

/** Host part of a from address ("Doug <d@x.com>" → "x.com"). */
export function hostOfFromAddress(value: string | undefined): string | null {
  const addr = addrSpecOf(value);
  if (!addr) return null;
  const at = addr.lastIndexOf("@");
  if (at === -1 || at === addr.length - 1) return null;
  return addr.slice(at + 1);
}
