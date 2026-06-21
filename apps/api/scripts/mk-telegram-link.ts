/**
 * Dev helper: mint a one-tap Telegram `/start` deep link bound to an email, so a
 * single tap links the tapping Telegram account to that contact.
 *
 *   pnpm --filter @hogsend/api telegram:link you@example.com
 *
 * Stores `token → email` in the same Redis the API reads, with a 15-min TTL.
 * Reads TELEGRAM_BOT_TOKEN + REDIS_URL from apps/api/.env (via --env-file).
 */
import { randomBytes } from "node:crypto";
import Redis from "ioredis";

const LINK_PREFIX = "hogsend:telegram:link:";

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("usage: telegram:link <email>");
    process.exit(1);
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("TELEGRAM_BOT_TOKEN is not set (apps/api/.env)");
    process.exit(1);
  }

  const me = (await fetch(`https://api.telegram.org/bot${botToken}/getMe`).then(
    (r) => r.json(),
  )) as { ok: boolean; result?: { username?: string } };
  const username = me?.result?.username;
  if (!username) {
    console.error("getMe failed:", JSON.stringify(me));
    process.exit(1);
  }

  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6380");
  const token = randomBytes(16).toString("hex");
  await redis.set(`${LINK_PREFIX}${token}`, email, "EX", 900);
  await redis.quit();

  console.log(`\n  Bound ${email} → /start token (valid 15 min)\n`);
  console.log(`  https://t.me/${username}?start=${token}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
