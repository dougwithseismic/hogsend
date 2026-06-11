import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: LucideIcon;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <span className="eyebrow text-white/50">{label}</span>
        {Icon ? (
          <Icon strokeWidth={1.5} className="h-4 w-4 text-white/30" />
        ) : null}
      </CardHeader>
      <CardContent>
        <div className="font-display text-[28px] leading-none text-white tracking-[-0.02em]">
          {value}
        </div>
        {hint ? <p className="mt-2 text-xs text-white/50">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}
