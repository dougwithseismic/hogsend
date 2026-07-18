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
import { DealsView } from "@/views/deals-view";
import { EventsView } from "@/views/events-view";
import { FlagEditorView } from "@/views/flags/flag-editor-view";
import { FlagsView } from "@/views/flags-view";
import { GroupDetailView } from "@/views/group-detail-view";
import { GroupsView } from "@/views/groups-view";
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

const linksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/links",
  component: LinksView,
});

const dealsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/deals",
  component: DealsView,
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

const flagsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/flags",
  component: FlagsView,
});

// `/flags/new` must be registered BEFORE `/flags/$flagId` so the literal path
// wins over the param route (otherwise "new" would match as a flag id).
const flagNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/flags/new",
  component: function FlagNewRoute() {
    return <FlagEditorView mode="create" />;
  },
});

const flagEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/flags/$flagId",
  // Same prop-threading pattern as the campaign/journey detail routes: read the
  // param here so the view stays router-agnostic.
  component: function FlagEditRoute() {
    const { flagId } = flagEditRoute.useParams();
    return <FlagEditorView mode="edit" flagId={flagId} />;
  },
});

const bucketsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/buckets",
  component: BucketsView,
});

const groupsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/groups",
  component: GroupsView,
});

const groupDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/groups/$groupType/$groupKey",
  // Same prop-threading pattern as the campaign/journey detail routes: read the
  // params here so the view stays router-agnostic.
  component: function GroupDetailRoute() {
    const { groupType, groupKey } = groupDetailRoute.useParams();
    return <GroupDetailView groupType={groupType} groupKey={groupKey} />;
  },
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
  linksRoute,
  qrCodesRoute,
  dealsRoute,
  campaignsRoute,
  campaignDetailRoute,
  journeysRoute,
  journeyDetailRoute,
  blueprintDetailRoute,
  flagsRoute,
  flagNewRoute,
  flagEditRoute,
  bucketsRoute,
  groupsRoute,
  groupDetailRoute,
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
