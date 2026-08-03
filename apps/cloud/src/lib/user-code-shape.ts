/**
 * The SHAPE of a CLI user code — alphabet and length — and nothing else.
 *
 * A pure module on purpose: the segmented input on `/cli/approve` is a client
 * component, and the service that mints codes (`src/services/cli-device-codes`)
 * transitively imports the database, which a browser bundle must never pull
 * in. This is the single definition; the service imports from HERE, so the
 * two sides cannot drift.
 */

/**
 * The user-code alphabet: no `I`, `L`, `O`, `U`, no `0` and no `1`.
 *
 * Read-aloud safety is the whole requirement — `0`/`O` and `1`/`I`/`L` are the
 * pairs a human transcribes wrong, and `U` is dropped so no random draw spells
 * something a support call has to apologise for. 30 symbols over 8 characters
 * is ~39 bits, which is not the security boundary (the device code is) but is
 * far past what the rate limiter admits.
 */
export const USER_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `XXXX-XXXX` — two groups of four, hyphenated for reading. */
export const USER_CODE_GROUP = 4;
export const USER_CODE_GROUPS = 2;

/** Eight characters once the display hyphen is stripped. */
export const USER_CODE_LENGTH = USER_CODE_GROUP * USER_CODE_GROUPS;
