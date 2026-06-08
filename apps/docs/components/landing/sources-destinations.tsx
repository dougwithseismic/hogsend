import {
  ArrowDown,
  ArrowRight,
  Code2,
  Database,
  Inbox,
  Send,
  Users,
  Webhook,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";
import { type BrandKey, BrandLogo } from "@/components/ds/brand-logo";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

const ICON_SIZE = 16;

/** A node in the flow — either a real masked brand mark or a lucide icon. */
type Node =
  | { kind: "brand"; brand: BrandKey; label: string }
  | { kind: "icon"; icon: ReactNode; label: string };

const SOURCES: Node[] = [
  { kind: "brand", brand: "posthog", label: "PostHog" },
  { kind: "brand", brand: "stripe", label: "Stripe" },
  { kind: "brand", brand: "segment", label: "Segment" },
  {
    kind: "icon",
    icon: <Code2 size={ICON_SIZE} strokeWidth={1.5} />,
    label: "Your own app",
  },
  {
    kind: "icon",
    icon: <Webhook size={ICON_SIZE} strokeWidth={1.5} />,
    label: "Any webhook",
  },
];

const DESTINATIONS: Node[] = [
  { kind: "brand", brand: "posthog", label: "PostHog" },
  { kind: "brand", brand: "segment", label: "Segment" },
  { kind: "brand", brand: "slack", label: "Slack" },
  {
    kind: "icon",
    icon: <Users size={ICON_SIZE} strokeWidth={1.5} />,
    label: "Your CRM",
  },
  {
    kind: "icon",
    icon: <Database size={ICON_SIZE} strokeWidth={1.5} />,
    label: "Your warehouse",
  },
];

function NodeChip({ node }: { node: Node }) {
  return (
    <li className="flex items-center gap-2.5 rounded-lg border border-black/[0.07] bg-white px-3 py-2.5">
      <span className="grid size-7 shrink-0 place-items-center rounded-md border border-black/[0.06] bg-black/[0.02] text-black/70">
        {node.kind === "brand" ? (
          <BrandLogo brand={node.brand} height={15} className="text-black/75" />
        ) : (
          node.icon
        )}
      </span>
      <span className="text-black/80 text-sm">{node.label}</span>
    </li>
  );
}

/** Side panel: a labelled stack of flow nodes (events in / events out). */
function FlowPanel({
  icon,
  title,
  nodes,
}: {
  icon: ReactNode;
  title: string;
  nodes: Node[];
}) {
  return (
    <Card tone="light" ticks className="flex h-full flex-col">
      <div className="flex items-center gap-2.5">
        {icon}
        <h3 className="font-display text-lg">{title}</h3>
      </div>
      <ul className="mt-5 flex flex-col gap-2.5">
        {nodes.map((node) => (
          <NodeChip key={node.label} node={node} />
        ))}
      </ul>
    </Card>
  );
}

/** Flow arrow — points down when the diagram stacks, right when it's a row. */
function FlowArrow() {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center py-1 text-black/25 lg:py-0"
    >
      <ArrowDown size={20} strokeWidth={1.5} className="lg:hidden" />
      <ArrowRight size={20} strokeWidth={1.5} className="hidden lg:block" />
    </span>
  );
}

/**
 * "Sources & destinations" — the inbound → react → outbound story as a visual
 * flow: brand marks stream in on the left, the engine reacts in the middle, and
 * every signal fans back out on the right. Light section; reads left-to-right on
 * desktop, top-to-bottom on mobile.
 */
export function SourcesDestinations() {
  return (
    <Section tone="light" id="sources-destinations">
      <Reveal>
        <SectionHeading
          tone="light"
          eyebrow="SOURCES & DESTINATIONS"
          title="Any source in. Any destination out."
          subtitle="Events flow in from the tools you already run, your journeys and buckets react in code, and every send and signal fans back out — no new system of record to keep in sync."
        />
      </Reveal>

      <Reveal delay={0.1}>
        <div className="mt-12 flex flex-col items-stretch gap-3 md:mt-16 lg:flex-row lg:items-center">
          <div className="lg:flex-1">
            <FlowPanel
              icon={<Inbox size={18} strokeWidth={1.5} />}
              title="Events in"
              nodes={SOURCES}
            />
          </div>

          <FlowArrow />

          {/* The engine — the reactive middle the two sides hang off. */}
          <div className="flex shrink-0 flex-col items-center gap-2 self-center rounded-xl border border-black/10 bg-white px-7 py-6 ring-1 ring-accent/30">
            <Workflow size={22} strokeWidth={1.5} />
            <span className="font-mono text-[11px] uppercase tracking-wide">
              Journeys + Buckets
            </span>
            <span className="text-black/45 text-xs">react in code</span>
          </div>

          <FlowArrow />

          <div className="lg:flex-1">
            <FlowPanel
              icon={<Send size={18} strokeWidth={1.5} />}
              title="Events out"
              nodes={DESTINATIONS}
            />
          </div>
        </div>
      </Reveal>

      <Reveal delay={0.16}>
        <div className="mt-10 flex justify-center">
          <Button href="/integrations" variant="outline" tone="light">
            See all integrations
          </Button>
        </div>
      </Reveal>
    </Section>
  );
}
