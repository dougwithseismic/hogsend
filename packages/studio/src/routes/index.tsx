import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { AppShell } from "@/components/layout/app-shell";
import { BlueprintDetailView } from "@/views/blueprint-detail-view";
import { BucketsView } from "@/views/buckets-view";
import { CampaignDetailView } from "@/views/campaign-detail-view";
import { CampaignsView } from "@/views/campaigns-view";
import { ContactsView } from "@/views/contacts-view";
import { EventsView } from "@/views/events-view";
import { IntegrationsView } from "@/views/integrations-view";
import { JourneyDetailView } from "@/views/journey-detail-view";
import { JourneysView } from "@/views/journeys-view";
import { LinksView } from "@/views/links-view";
import { OverviewView } from "@/views/overview-view";
import { QrCodesView } from "@/views/qr-codes-view";
import { SendsView } from "@/views/sends-view";
import { SettingsView } from "@/views/settings-view";
import { SetupView } from "@/views/setup-view";
import { SuppressionsView } from "@/views/suppressions-view";
import { TemplatesView } from "@/views/templates-view";
import { VoiceAgentsView } from "@/views/voice-agents-view";

const rootRoute = createRootRoute({
  component: AppShell,
});

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: OverviewView,
});

const eventsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/events",
  component: EventsView,
});

const sendsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sends",
  component: SendsView,
});

const templatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/templates",
  component: TemplatesView,
});

const voiceAgentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/voice-agents",
  component: VoiceAgentsView,
});

const linksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/links",
  component: LinksView,
});

const qrCodesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/qr-codes",
  component: QrCodesView,
});

const campaignsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/campaigns",
  component: CampaignsView,
});

const campaignDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/campaigns/$campaignId",
  // Same prop-threading pattern as the journey detail route below: read the
  // param here so the view stays router-agnostic.
  component: function CampaignDetailRoute() {
    const { campaignId } = campaignDetailRoute.useParams();
    return <CampaignDetailView campaignId={campaignId} />;
  },
});

const journeysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/journeys",
  component: JourneysView,
});

const journeyDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/journeys/$journeyId",
  // Read the path param here and hand it down as a plain prop so the view stays
  // router-agnostic (and there's no view↔route circular import).
  component: function JourneyDetailRoute() {
    const { journeyId } = journeyDetailRoute.useParams();
    return <JourneyDetailView journeyId={journeyId} />;
  },
});

const blueprintDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/journeys/blueprints/$blueprintId",
  // Same prop-threading pattern as journeyDetailRoute above.
  component: function BlueprintDetailRoute() {
    const { blueprintId } = blueprintDetailRoute.useParams();
    return <BlueprintDetailView blueprintId={blueprintId} />;
  },
});

const bucketsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/buckets",
  component: BucketsView,
});

const contactsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contacts",
  component: ContactsView,
});

const suppressionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/suppressions",
  component: SuppressionsView,
});

const integrationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/integrations",
  component: IntegrationsView,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupView,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsView,
});

const routeTree = rootRoute.addChildren([
  overviewRoute,
  eventsRoute,
  sendsRoute,
  templatesRoute,
  voiceAgentsRoute,
  linksRoute,
  qrCodesRoute,
  campaignsRoute,
  campaignDetailRoute,
  journeysRoute,
  journeyDetailRoute,
  blueprintDetailRoute,
  bucketsRoute,
  contactsRoute,
  suppressionsRoute,
  integrationsRoute,
  setupRoute,
  settingsRoute,
]);

export const router = createRouter({
  routeTree,
  // Studio is mounted under /studio; matches vite `base`.
  basepath: "/studio",
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
