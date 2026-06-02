import {
  Ban,
  GitBranch,
  LayoutDashboard,
  type LucideIcon,
  Mail,
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
  { label: "Journeys", path: "/journeys", icon: GitBranch },
  { label: "Contacts", path: "/contacts", icon: Users },
  { label: "Suppressions", path: "/suppressions", icon: Ban },
  { label: "Settings", path: "/settings", icon: Settings },
];
