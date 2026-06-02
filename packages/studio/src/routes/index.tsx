import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { AppShell } from "@/components/layout/app-shell";
import { ContactsView } from "@/views/contacts-view";
import { JourneysView } from "@/views/journeys-view";
import { OverviewView } from "@/views/overview-view";
import { SendsView } from "@/views/sends-view";
import { SettingsView } from "@/views/settings-view";
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

const journeysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/journeys",
  component: JourneysView,
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

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsView,
});

const routeTree = rootRoute.addChildren([
  overviewRoute,
  sendsRoute,
  templatesRoute,
  journeysRoute,
  contactsRoute,
  suppressionsRoute,
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
