import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

export type NavigationIndicatorPosition = "bottom-right" | "bottom-center";

export function NavigationIndicator({
  children,
  position = "bottom-right",
}: {
  children: ReactNode;
  position?: NavigationIndicatorPosition;
}) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute z-[1] flex",
        position === "bottom-center" ? "bottom-0.5 left-1/2 -translate-x-1/2" : "bottom-0.5 right-0.5",
      )}
    >
      {children}
    </span>
  );
}

export function UpdateNavigationDot() {
  return <span className="size-2 rounded-full bg-amber-400 ring-2 ring-background" aria-hidden="true" />;
}
