import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowUpRight, BookOpen } from "lucide-react";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";
import { Logo } from "./logo";
import { navItems } from "./nav";

export function Sidebar() {
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  });

  return (
    <aside className="flex h-full w-60 flex-col border-r border-hairline bg-ink">
      <div className="flex h-14 items-center border-b border-hairline px-5">
        <Logo />
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        {navItems.map((item) => {
          const active =
            item.path === "/"
              ? pathname === "/"
              : pathname.startsWith(item.path);
          const Icon = item.icon;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-[15px] tracking-[-0.02em] outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-accent",
                active
                  ? "bg-accent-tint text-accent"
                  : "text-white/60 hover:bg-white/5 hover:text-white",
              )}
            >
              <Icon strokeWidth={1.5} className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-hairline p-2">
        <a
          href={links.docs}
          target="_blank"
          rel="noreferrer"
          className="group flex items-center gap-3 rounded-md px-3 py-2 text-[15px] tracking-[-0.02em] text-white/60 outline-none transition-colors duration-200 hover:bg-white/5 hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
        >
          <BookOpen strokeWidth={1.5} className="h-4 w-4" />
          Docs
          <ArrowUpRight className="ml-auto h-3.5 w-3.5 opacity-60 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </a>
      </div>
    </aside>
  );
}
