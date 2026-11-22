import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

// Tailwind size names are shifted one step in coss.css: text-sm is --text-base (13 px).
/** What will appear here, and the one action that makes it appear (web/DESIGN.md). */
export function EmptyState(props: {
  icon: LucideIcon;
  title: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  role?: "alert";
}) {
  const Icon = props.icon;
  return (
    <Empty className="gap-4 px-6 py-12 md:py-12" role={props.role}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon className="text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle className="font-semibold text-sm">{props.title}</EmptyTitle>
        <EmptyDescription>{props.children}</EmptyDescription>
      </EmptyHeader>
      {props.action && (
        <EmptyContent className="flex flex-col items-center gap-3">{props.action}</EmptyContent>
      )}
    </Empty>
  );
}
