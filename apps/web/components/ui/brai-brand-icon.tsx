import { cn } from "@/components/ui/cn";

export function BraiBrandIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("block size-5 shrink-0", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 20V4" />
      <path d="M12 20 8.8 4.8" />
      <path d="M12 20 5.9 6.2" />
      <path d="M12 20 3.6 8.7" />
      <path d="M12 20 2.3 12" />
      <path d="M12 20 15.2 4.8" />
      <path d="M12 20 18.1 6.2" />
      <path d="M12 20 20.4 8.7" />
      <path d="M12 20 21.7 12" />
    </svg>
  );
}
