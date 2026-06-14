/**
 * Dev helper: mint a signed Discord member-link authorize URL bound to a
 * specific contact + email. Run with:
 *   pnpm --filter @hogsend/api exec tsx --env-file=.env scripts/mk-discord-link.ts [contactId] [email]
 */
import { randomBytes } from "node:crypto";
import { signConnectorState } from "@hogsend/engine";
import { buildMemberLinkUrl } from "@hogsend/plugin-discord";

const secret = process.env.BETTER_AUTH_SECRET;
const appId = process.env.DISCORD_APPLICATION_ID;
const apiUrl = process.env.API_PUBLIC_URL ?? "http://localhost:3002";
if (!secret || !appId) {
  throw new Error(
    "missing BETTER_AUTH_SECRET or DISCORD_APPLICATION_ID in env",
  );
}

const contactId = process.argv[2] ?? "13d0d58e-ef87-4654-8d51-134d567ac1f4";
const email = process.argv[3] ?? "doug@withseismic.com";

const state = signConnectorState(
  {
    purpose: "member_link",
    connectorId: "discord",
    contactId,
    email,
    nonce: randomBytes(16).toString("base64url"),
  },
  secret,
  900,
);

const url = buildMemberLinkUrl({
  applicationId: appId,
  redirectUri: `${apiUrl}/v1/connectors/discord/oauth/callback`,
  state,
});

console.log(`\nbound to contact ${contactId} / ${email}\n\n${url}\n`);
