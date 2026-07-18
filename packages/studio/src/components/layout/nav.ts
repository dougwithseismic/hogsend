import {
  Activity,
  Ban,
  Boxes,
  Building2,
  Flag,
  GitBranch,
  Globe,
  HandCoins,
  LayoutDashboard,
  Link2,
  type LucideIcon,
  Mail,
  Megaphone,
  Plug,
  QrCode,
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
  { label: "Events", path: "/events", icon: Activity },
  { label: "Sends", path: "/sends", icon: Send },
  { label: "Templates", path: "/templates", icon: Mail },
  { label: "Links", path: "/links", icon: Link2 },
  { label: "QR codes", path: "/qr-codes", icon: QrCode },
  { label: "Campaigns", path: "/campaigns", icon: Megaphone },
  { label: "Deals", path: "/deals", icon: HandCoins },
  { label: "Journeys", path: "/journeys", icon: GitBranch },
  { label: "Flags", path: "/flags", icon: Flag },
  { label: "Buckets", path: "/buckets", icon: Boxes },
  { label: "Groups", path: "/groups", icon: Building2 },
  { label: "Contacts", path: "/contacts", icon: Users },
  { label: "Suppressions", path: "/suppressions", icon: Ban },
  { label: "Integrations", path: "/integrations", icon: Plug },
  { label: "Setup", path: "/setup", icon: Globe },
  { label: "Settings", path: "/settings", icon: Settings },
];
