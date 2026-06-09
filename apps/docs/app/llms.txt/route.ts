// /llms.txt — the stable, machine-readable entrypoint for AI agents.
// Handwritten content (llms.txt convention: H1 + summary blockquote + sectioned
// link lists). Force-static so the standalone build emits it as a static asset.
export const dynamic = "force-static";

const CONTENT = `# Hogsend

> Hogsend is a code-first lifecycle email orchestration engine. You scaffold a
> versioned app with \`pnpm dlx create-hogsend@latest\`, define journeys
> (defineJourney), emails (react-email), lists, buckets, and webhook sources in
> TypeScript, and drive a running instance via the public data-plane API
> (@hogsend/client), the \`hogsend\` CLI, or the Studio admin UI. Durable
> execution runs on Hatchet; first-party open/click tracking is built in;
> Resend and Postmark ship as swappable email providers.

## Start here

- [Introduction](https://docs.hogsend.com/docs): what Hogsend is and who it is for
- [Getting started](https://docs.hogsend.com/docs/getting-started): scaffold and run your first app
- [Installation](https://docs.hogsend.com/docs/getting-started/installation): create-hogsend, infra, env
- [How it works](https://docs.hogsend.com/docs/concepts/how-it-works): engine-as-dependency architecture
- [Hogsend for AI agents](https://docs.hogsend.com/docs/agents): the agent onboarding page for this file

## Data-plane API (call Hogsend from your product)

- [Data API overview](https://docs.hogsend.com/docs/data-api): contacts, events, emails, lists
- [Client SDK (@hogsend/client)](https://docs.hogsend.com/docs/data-api/client-sdk): typed client for the data plane
- [Authentication](https://docs.hogsend.com/docs/data-api/authentication): ingest-scoped API keys
- [Events](https://docs.hogsend.com/docs/data-api/events): POST /v1/events, eventProperties vs contactProperties
- [Contacts](https://docs.hogsend.com/docs/data-api/contacts): PUT /v1/contacts upsert + identity
- [Emails](https://docs.hogsend.com/docs/data-api/emails): transactional sends by template
- [Webhooks](https://docs.hogsend.com/docs/data-api/webhooks): the signed outbound event stream
- [Destinations](https://docs.hogsend.com/docs/data-api/destinations): fan events out to PostHog/Segment/Slack

## Operating

- [CLI](https://docs.hogsend.com/docs/cli): the \`hogsend\` command — stats, contacts, events, journeys, skills
- [Integrations](https://docs.hogsend.com/docs/integrations): built-in Clerk/Supabase/Stripe/Segment webhook presets
- [Recipes](https://docs.hogsend.com/docs/recipes): end-to-end patterns

## Skills (agent-executable playbooks)

Every scaffolded Hogsend app ships 14 Claude Code skills in .claude/skills/
(also installable anywhere via \`hogsend skills add\`, from @hogsend/cli). They
cover authoring journeys/emails/lists/buckets/destinations, the client SDK,
the CLI, webhooks and workflows, database changes, deployment, extending
providers, conditions — plus two flagship flows:

- hogsend-integrate: wire an EXISTING product codebase (Next.js, Express,
  Hono, Remix, SvelteKit) to a running Hogsend instance via @hogsend/client.
- hogsend-migrate: migrate off Loops, Customer.io, or Resend Broadcasts with
  per-platform mapping tables and a dual-write cutover plan.

- [Skills overview](https://docs.hogsend.com/docs/agents): what ships and how to install
- [hogsend skills CLI](https://docs.hogsend.com/docs/cli/skills): list/add commands

## Packages

- create-hogsend (npm): scaffold a new app
- @hogsend/client (npm): typed data-plane SDK for your product code
- @hogsend/cli (npm): the \`hogsend\` CLI + bundled skills
- @hogsend/engine (npm): the framework your scaffolded app consumes
`;

export function GET(): Response {
  return new Response(CONTENT, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
