import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TagPill } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import { Section, SectionHeading } from "@/components/ds/section";
import { PageHeader } from "@/components/shell/page-header";
import {
  apiDocsEnabled,
  type OpenApiOperation,
  openApiDocument,
} from "@/src/openapi";

export const metadata: Metadata = {
  title: "API reference",
  description: "The control plane's OpenAPI 3.1 description.",
};

// The gate reads NODE_ENV per request, so this page must never be prerendered
// into a static 200 at build time.
export const dynamic = "force-dynamic";

type Endpoint = { path: string; method: string; operation: OpenApiOperation };

const ENDPOINTS: Endpoint[] = Object.entries(openApiDocument.paths).map(
  ([path, item]) => ({ path, method: "GET", operation: item.get }),
);

export default function ApiDocsPage() {
  // Dev-only: in production this route does not exist at all.
  if (!apiDocsEnabled(process.env.NODE_ENV)) notFound();

  return (
    <main className="flex flex-1 flex-col">
      <PageHeader
        title="API reference"
        description={openApiDocument.info.description}
        actions={<TagPill tone="caution">Development only</TagPill>}
      />

      <Section divider={false}>
        <SectionHeading
          eyebrow={`OpenAPI ${openApiDocument.openapi}`}
          title="Endpoints"
          subtitle="Hand-written and covered by a test that calls the real handler, so the shapes below are the shapes the API returns."
        />

        <div className="mt-8 flex flex-col gap-4">
          {ENDPOINTS.map((endpoint) => (
            <EndpointCard key={endpoint.path} endpoint={endpoint} />
          ))}
        </div>
      </Section>

      <Section>
        <SectionHeading
          eyebrow="Machine readable"
          title="Raw document"
          subtitle="Paste this into any OpenAPI client. It is generated from the same object the page above renders."
        />
        <Card className="mt-8 overflow-x-auto p-0">
          <pre className="p-6 font-mono text-[13px] text-white/70 leading-6">
            {JSON.stringify(openApiDocument, null, 2)}
          </pre>
        </Card>
      </Section>
    </main>
  );
}

function EndpointCard({ endpoint }: { endpoint: Endpoint }) {
  const schema =
    endpoint.operation.responses["200"].content["application/json"].schema;

  return (
    <Card className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <TagPill tone="good">{endpoint.method}</TagPill>
          <code className="font-mono text-[15px] text-white">
            {endpoint.path}
          </code>
          <span className="text-sm text-white/40">
            {endpoint.operation.summary}
          </span>
        </div>
        <p className="max-w-3xl text-base text-white/60 leading-6">
          {endpoint.operation.description}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="font-medium text-sm text-white/80">
          200 — {endpoint.operation.responses["200"].description}
        </h3>
        <div className="overflow-x-auto rounded-md border border-white/[0.08]">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-white/[0.08] border-b text-white/40">
                <th className="px-4 py-2.5 font-medium">Field</th>
                <th className="px-4 py-2.5 font-medium">Values</th>
                <th className="px-4 py-2.5 font-medium">Meaning</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(schema.properties).map(([name, property]) => (
                <tr
                  key={name}
                  className="border-white/[0.06] border-b last:border-b-0"
                >
                  <td className="px-4 py-3 align-top font-mono text-white">
                    {name}
                  </td>
                  <td className="px-4 py-3 align-top font-mono text-white/70">
                    {property.enum.join(" | ")}
                  </td>
                  <td className="px-4 py-3 align-top text-white/60 leading-6">
                    {property.description}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}
