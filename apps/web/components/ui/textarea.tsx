import * as React from "react";

import { cn } from "@/components/ui/cn";

export type TextareaProps = React.ComponentProps<"textarea"> & {
  size?: "sm" | "default" | "lg" | number;
  unstyled?: boolean;
  bare?: boolean;
};

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { bare = false, className, size = "default", unstyled = false, ...props },
  ref,
) {
  if (bare) {
    return <textarea ref={ref} data-slot="textarea" className={className} {...props} />;
  }

  if (unstyled) {
    return (
      <span className={className} data-size={size} data-slot="textarea-control">
        <textarea
          ref={ref}
          data-slot="textarea"
          className={cn(
            "field-sizing-content min-h-17.5 w-full rounded-[inherit] px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] outline-none max-sm:min-h-20.5",
            size === "sm" && "min-h-16.5 px-[calc(--spacing(2.5)-1px)] py-[calc(--spacing(1)-1px)] max-sm:min-h-19.5",
            size === "lg" && "min-h-18.5 py-[calc(--spacing(2)-1px)] max-sm:min-h-21.5",
          )}
          {...props}
        />
      </span>
    );
  }

  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      className={cn(
        "flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});

export { Textarea };
