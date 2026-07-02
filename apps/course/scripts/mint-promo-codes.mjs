// Mint N single-use 100%-off promotion codes for a course — the "free copy"
// lever (hand them to community members, speakers, refunds-as-goodwill, …).
// Mirrors lib/gifts.ts mintPromotionCode (this script stays alias-free so it
// runs as plain node); codes are prefixed FREE- to tell them apart from
// purchased gifts, and both coupon and codes carry mintedBy metadata.
//
// Usage:
//   STRIPE_SECRET_KEY=sk_… STRIPE_PRICE_GROWTH_WITH_POSTHOG=price_… \
//     node scripts/mint-promo-codes.mjs --course growth-with-posthog --count 5
//   Flags: --course <slug> (required) · --count <n> (default 1)
//          --percent <1-100> (default 100) · --dry-run
import { randomBytes } from "node:crypto";
import Stripe from "stripe";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const course = flag("course", "");
const count = Number(flag("count", "1"));
const percent = Number(flag("percent", "100"));
const dryRun = args.includes("--dry-run");

if (!course || !Number.isInteger(count) || count < 1 || count > 100) {
  console.error(
    "usage: node scripts/mint-promo-codes.mjs --course <slug> [--count n] [--percent 1-100] [--dry-run]",
  );
  process.exit(1);
}
if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
  console.error(`--percent must be 1-100, got ${percent}`);
  process.exit(1);
}

const priceEnv = `STRIPE_PRICE_${course.toUpperCase().replaceAll("-", "_")}`;
const priceId = process.env[priceEnv];
const secretKey = process.env.STRIPE_SECRET_KEY;

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateCode() {
  const bytes = randomBytes(8);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `FREE-${out}`;
}

if (dryRun) {
  console.log(
    `[dry-run] would mint ${count} single-use ${percent}%-off code(s) for "${course}"`,
  );
  console.log(`[dry-run] price env ${priceEnv} = ${priceId ?? "(unset!)"}`);
  console.log(
    `[dry-run] STRIPE_SECRET_KEY ${secretKey ? "present" : "(unset!)"}`,
  );
  for (let i = 0; i < count; i++)
    console.log(`[dry-run] e.g. ${generateCode()}`);
  process.exit(priceId && secretKey ? 0 : 1);
}

if (!secretKey) {
  console.error("STRIPE_SECRET_KEY is not set");
  process.exit(1);
}
if (!priceId) {
  console.error(`${priceEnv} is not set — no price mapped for "${course}"`);
  process.exit(1);
}

const stripe = new Stripe(secretKey);
const price = await stripe.prices.retrieve(priceId);
const productId =
  typeof price.product === "string" ? price.product : price.product.id;

const coupon = await stripe.coupons.create({
  percent_off: percent,
  duration: "once",
  max_redemptions: count,
  applies_to: { products: [productId] },
  name: `Free copies: ${course}`,
  metadata: { courseSlug: course, mintedBy: "admin-script" },
});

const codes = [];
for (let i = 0; i < count; i++) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCode();
    try {
      await stripe.promotionCodes.create({
        promotion: { type: "coupon", coupon: coupon.id },
        code,
        max_redemptions: 1,
        metadata: { courseSlug: course, mintedBy: "admin-script" },
      });
      codes.push(code);
      break;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
}

console.log(`coupon ${coupon.id} (${percent}% off, product ${productId})`);
for (const code of codes) console.log(code);
