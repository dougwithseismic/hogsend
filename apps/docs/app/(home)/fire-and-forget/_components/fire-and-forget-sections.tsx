import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { JSX } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { CopyButton } from "@/components/ds/copy-button";
import { AuroraBeam } from "@/components/ds/fx";
import { CodeMock } from "@/components/ds/mockup";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { RAILWAY_DEPLOY_URL } from "@/lib/site";

const GUIDE_HREF = "/docs/operating/production-email";

const FIRE_COMMAND = `curl -X POST https://your-api/v1/events \\
  -H "Authorization: Bearer $HOGSEND_API_KEY" \\
  -d '{"name":"user.created","email":"you@yourdomain.com"}'`;

/* ------------------------------------------------------------------------ */
/* Hero                                                                      */
/* ------------------------------------------------------------------------ */

export function FireForgetHero(): JSX.Element {
  return (
    <Section divider={false} containerClassName="container-page pt-32 pb-20">
      <AuroraBeam />
      <div className="relative z-10 flex flex-col items-center text-center">
        <Reveal className="flex flex-col items-center">
          <Eyebrow>Fire and forget</Eyebrow>
          <h1 className="mt-6 max-w-4xl font-display font-medium text-[40px] text-white leading-[1.05] tracking-[-0.05em] md:text-[64px] md:leading-[1.0]">
            Lifecycle marketing
            <br />
            built for agents
          </h1>
          <p className="mt-6 max-w-xl text-base text-white/80 leading-6">
            Set the loop up once — by hand in half an hour, or hand the guide to
            your agent. Journeys run from your repo after that.
          </p>
        </Reveal>
        <Reveal delay={0.1} className="mt-12 flex flex-col items-center gap-5">
          <div className="flex flex-wrap items-center justify-center gap-4">
            <Button href={GUIDE_HREF} icon>
              Read the guide
            </Button>
            <a
              href={RAILWAY_DEPLOY_URL}
              className="inline-flex rounded-[6px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {/* biome-ignore lint/performance/noImgElement: external Railway button SVG, not a local asset */}
              <img
                src="https://railway.com/button.svg"
                alt="Deploy on Railway"
                className="h-[42px]"
              />
            </a>
          </div>
          <p className="font-mono text-[11px] text-white/50 uppercase tracking-[0.08em]">
            About 30 minutes · No mailbox provider · No Google account
          </p>
        </Reveal>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------------ */
/* Premise — manifesto-style statement                                       */
/* ------------------------------------------------------------------------ */

export function Premise(): JSX.Element {
  return (
    <Section>
      <Reveal className="flex flex-col items-center text-center">
        <Eyebrow className="mb-8">The premise</Eyebrow>
        <p className="mx-auto max-w-[900px] font-display text-[24px] text-white/90 leading-[34px] tracking-[-0.02em] md:text-[34px] md:leading-[46px]">
          We took a fresh domain to production lifecycle email in about half an
          hour — on hogsend.com itself. No mailbox provider, no Google account.
          Every step has a checkable result, which is exactly what an agent
          needs.
        </p>
      </Reveal>
    </Section>
  );
}

/* ------------------------------------------------------------------------ */
/* The path — seven steps, each with a terminal-style checkpoint             */
/* ------------------------------------------------------------------------ */

type StepCheckLine = {
  text: string;
  tone?: "plain" | "comment" | "accent";
};

type Step = {
  title: string;
  body: string;
  anchor: string;
  check: StepCheckLine[];
};

const STEPS: Step[] = [
  {
    title: "Prerequisites",
    body: "A domain on Cloudflare, a Resend account, and somewhere to deploy — the Railway template or your own infrastructure. Any DNS host works; Cloudflare gets the inbound trick for free.",
    anchor: "what-you-need",
    check: [
      { text: "$ dig +short NS yourdomain.com" },
      { text: "ada.ns.cloudflare.com.", tone: "accent" },
    ],
  },
  {
    title: "Create a Resend key",
    body: "Pick a team, create one full-access API key, add your domain and choose a region. Full access matters — a send-only key cannot read domain status, which silently disables Hogsend's automatic test-mode safety.",
    anchor: "1-create-a-resend-key-and-add-your-domain",
    check: [
      { text: "$ curl -s https://api.resend.com/domains \\" },
      { text: '    -H "Authorization: Bearer $RESEND_API_KEY"' },
      { text: '"status": "not_started"', tone: "accent" },
    ],
  },
  {
    title: "Set four DNS records",
    body: "DKIM, MX and SPF live on the send subdomain, DMARC on the root — so they coexist with anything already on the domain. All DNS-only, unproxied. Start DMARC at p=none and tighten later.",
    anchor: "2-add-four-dns-records",
    check: [
      { text: "$ dig +short TXT resend._domainkey.yourdomain.com" },
      { text: '"p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQ…"', tone: "accent" },
    ],
  },
  {
    title: "Verify the domain",
    body: "Trigger verification from the dashboard or the API, then poll until the status reads verified. Usually under a minute on Cloudflare.",
    anchor: "3-verify-the-domain",
    check: [
      { text: "$ curl -s https://api.resend.com/domains/$DOMAIN_ID \\" },
      { text: '    -H "Authorization: Bearer $RESEND_API_KEY"' },
      { text: '"status": "verified"', tone: "accent" },
    ],
  },
  {
    title: "Inbound, without a mailbox",
    body: "Cloudflare Email Routing forwards hello@ and a catch-all to the inbox you already have. Reply as hello@ through Gmail's send-as, over smtp.resend.com with your API key as the password. Total mailbox cost: zero.",
    anchor: "4-receive-replies-without-a-mailbox",
    check: [
      { text: "$ # send a test to hello@yourdomain.com", tone: "comment" },
      { text: "delivered → your existing inbox", tone: "accent" },
    ],
  },
  {
    title: "Deploy",
    body: "The Railway template is one click; create-hogsend scaffolds the same app if you would rather deploy it yourself. A fresh deploy mints an ingest-scoped API key on first boot and prints it once in the deploy log.",
    anchor: "5-deploy",
    check: [
      { text: "$ curl -s https://your-api/v1/health" },
      { text: '"status": "healthy"', tone: "accent" },
    ],
  },
  {
    title: "Fire",
    body: "One event in. The welcome journey runs and the email arrives from your domain, DKIM-signed. The health endpoint counts it.",
    anchor: "6-fire-the-first-event",
    check: [
      { text: "$ curl -X POST https://your-api/v1/events \\" },
      { text: '    -H "Authorization: Bearer $HOGSEND_API_KEY" \\' },
      { text: `    -d '{"name":"user.created",` },
      { text: `         "email":"you@yourdomain.com"}'` },
      { text: "activity.emails.sent → 1", tone: "accent" },
    ],
  },
];

export function ThePath(): JSX.Element {
  return (
    <Section id="the-path">
      <SectionHeading
        eyebrow="The path"
        title="Seven steps, each with a check"
        subtitle="The short version of the guide. Every step ends with a command whose output tells you it worked — run, check, proceed."
      />
      <div className="mt-12 flex flex-col">
        {STEPS.map((step, index) => (
          <Reveal key={step.anchor} delay={(index % 2) * 0.08}>
            <div className="grid grid-cols-1 gap-6 border-white/[0.08] border-t py-10 lg:grid-cols-2 lg:gap-12">
              <div className="flex flex-col items-start">
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-accent text-sm">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
                    {step.title}
                  </h3>
                </div>
                <p className="mt-3 max-w-md text-base text-white/60 leading-6">
                  {step.body}
                </p>
                <Link
                  href={`${GUIDE_HREF}#${step.anchor}`}
                  className="group mt-4 inline-flex items-center gap-1.5 text-sm text-white/60 transition-colors hover:text-white"
                >
                  In the guide
                  <ArrowUpRight
                    aria-hidden="true"
                    className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
                    strokeWidth={1.5}
                  />
                </Link>
              </div>
              <CodeMock filename="checkpoint" lines={step.check} />
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------------ */
/* Gotchas — the parts that bite                                             */
/* ------------------------------------------------------------------------ */

const GOTCHAS: Array<{ title: string; body: string }> = [
  {
    title: "Root domains on Cloudflare + Railway",
    body: "Cloudflare flattens root CNAMEs, which breaks Railway's certificate validation. Set the record to Proxied with zone SSL mode Full — never Flexible — or use Railway's one-click Cloudflare connect. Subdomains are unaffected.",
  },
  {
    title: "Restricted Resend keys",
    body: "Sends work, but the domains API returns 401. Hogsend warns once and assumes the domain is verified. Set HOGSEND_TEST_MODE=true if you want redirect-to-inbox safety with a restricted key.",
  },
  {
    title: "One domain on the free plan",
    body: "Resend's free plan holds exactly one domain. Repurposing a team means removing the old domain first.",
  },
  {
    title: "DMARC, gently",
    body: "Start at p=none and watch the reports before tightening to quarantine or reject.",
  },
];

export function Gotchas(): JSX.Element {
  return (
    <Section>
      <SectionHeading
        eyebrow="Gotchas"
        title="The parts that bite"
        subtitle="Found by setting this up for real on hogsend.com. The guide covers each in full."
      />
      <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2">
        {GOTCHAS.map((gotcha, index) => (
          <Reveal key={gotcha.title} delay={(index % 2) * 0.08}>
            <Card className="h-full">
              <h3 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
                {gotcha.title}
              </h3>
              <p className="mt-3 text-base text-white/60 leading-6">
                {gotcha.body}
              </p>
            </Card>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------------ */
/* Agent section — why an agent can run the whole thing                      */
/* ------------------------------------------------------------------------ */

const AGENT_POINTS: Array<{ title: string; body: string }> = [
  {
    title: "/llms.txt",
    body: "The docs are published for machines as well as people — one fetch and your agent has the whole guide.",
  },
  {
    title: "Vendored skills",
    body: "Every scaffold ships Claude Code skills in .claude/skills — journeys, emails, deploys, all documented where the agent works.",
  },
  {
    title: "The hogsend CLI",
    body: "Health, journeys, contacts, tokens — every command takes --json, so the agent can check its own work.",
  },
];

export function AgentSection(): JSX.Element {
  return (
    <Section id="agents">
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:gap-16">
        <div>
          <Reveal>
            <SectionHeading
              eyebrow="Built for agents"
              title="Hand the guide to your agent"
              subtitle="Every step on this page is a command or an API call with a checkable result. That is the property agents need: run, check, proceed. Point one at the guide and say set up my domain."
            />
            <div className="mt-10 flex flex-col gap-6">
              {AGENT_POINTS.map((point) => (
                <div key={point.title}>
                  <h3 className="font-medium font-mono text-sm text-white tracking-[-0.01em]">
                    {point.title}
                  </h3>
                  <p className="mt-2 max-w-md text-base text-white/60 leading-6">
                    {point.body}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-10 max-w-md text-sm text-white/50 leading-6">
              A one-command version — <code>hogsend email setup</code> — is on
              the way. The guide is its spec.
            </p>
          </Reveal>
        </div>
        <Reveal delay={0.08} className="lg:self-center">
          <CodeMock
            filename="your terminal"
            lines={[
              { text: "$ claude" },
              {
                text: "> Read hogsend.com/docs/operating/production-email",
                tone: "comment",
              },
              {
                text: "> and set up production email for acme.dev.",
                tone: "comment",
              },
              { text: "" },
              { text: "dns records created · 4/4" },
              { text: "domain verified · eu-west-1" },
              { text: "deploy healthy · /v1/health" },
              { text: "first email sent · dkim pass", tone: "accent" },
            ]}
          />
        </Reveal>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------------ */
/* Closing CTA — read the full guide                                         */
/* ------------------------------------------------------------------------ */

export function FinalCta(): JSX.Element {
  return (
    <Section>
      <Reveal>
        <div className="relative overflow-hidden rounded-md border border-white/10">
          {/* Red glow bleeding in from the left edge. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(70% 110% at 0% 60%, rgba(246, 72, 56, 0.22), transparent 60%)",
            }}
          />
          <div className="relative z-10 grid grid-cols-1 items-center gap-12 p-8 md:p-14 lg:grid-cols-2">
            <div>
              <h2 className="max-w-xl font-display text-[32px] text-white leading-[1.2] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
                Fresh domain to
                <br />
                first send, tonight
              </h2>
              <p className="mt-5 max-w-md text-base text-white/70 leading-6">
                The full guide has every record, every key, and every check —
                written from doing it for real on hogsend.com.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-4">
                <Button href={GUIDE_HREF} icon>
                  Read the full guide
                </Button>
                <a
                  href={RAILWAY_DEPLOY_URL}
                  className="inline-flex rounded-[6px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {/* biome-ignore lint/performance/noImgElement: external Railway button SVG, not a local asset */}
                  <img
                    src="https://railway.com/button.svg"
                    alt="Deploy on Railway"
                    className="h-[42px]"
                  />
                </a>
              </div>
              <p className="mt-6 font-mono text-[11px] text-white/50 uppercase tracking-[0.08em]">
                About 30 minutes · No mailbox provider · No Google account
              </p>
            </div>
            <div className="relative">
              <CodeMock
                filename="terminal"
                lines={[
                  { text: "$ curl -X POST https://your-api/v1/events \\" },
                  {
                    text: '    -H "Authorization: Bearer $HOGSEND_API_KEY" \\',
                  },
                  { text: `    -d '{"name":"user.created",` },
                  { text: `         "email":"you@yourdomain.com"}'` },
                  { text: "" },
                  { text: "202 Accepted", tone: "accent" },
                ]}
              />
              <CopyButton
                value={FIRE_COMMAND}
                className="absolute top-2.5 right-3"
              />
            </div>
          </div>
        </div>
      </Reveal>
    </Section>
  );
}
