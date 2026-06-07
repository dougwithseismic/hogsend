/**
 * Runtime guard mirroring the `Identity` union: at least one of `email` /
 * `userId` must be a non-empty string. The type system enforces this at the
 * call site, but runtime callers (plain JS, untyped data) can still violate it,
 * so we fail fast with a clear message before issuing the request.
 */
export function assertIdentity(input: {
  email?: string;
  userId?: string;
}): void {
  const hasEmail = typeof input.email === "string" && input.email.length > 0;
  const hasUserId = typeof input.userId === "string" && input.userId.length > 0;
  if (!hasEmail && !hasUserId) {
    throw new TypeError(
      "Hogsend: an identity is required — pass `email`, `userId`, or both.",
    );
  }
}
