import {
  Ban,
  Boxes,
  FlaskConical,
  GitBranch,
  Globe,
  LayoutDashboard,
  Link2,
  type LucideIcon,
  Mail,
  Plug,
  Send,
  Settings,
  Users,
} from "lucide-react";

export type NavItem = {
  label: string;
  path: string;
  icon: LucideIcon;
};

export const navItems: NavItem[] = [
  { label: "Overview", path: "/", icon: LayoutDashboard },
  { label: "Sends", path: "/sends", icon: Send },
  { label: "Templates", path: "/templates", icon: Mail },
  { label: "Links", path: "/links", icon: Link2 },
  { label: "Journeys", path: "/journeys", icon: GitBranch },
  { label: "Buckets", path: "/buckets", icon: Boxes },
  { label: "Contacts", path: "/contacts", icon: Users },
  { label: "Suppressions", path: "/suppressions", icon: Ban },
  { label: "Debug", path: "/debug", icon: FlaskConical },
  { label: "Integrations", path: "/integrations", icon: Plug },
  { label: "Setup", path: "/setup", icon: Globe },
  { label: "Settings", path: "/settings", icon: Settings },
];
