// ABOUTME: Показывает готовый DEV знак Brai-Old в навигации DEV приложения.
// ABOUTME: Ресурс закреплён только в dev; размер и декоративная доступность сохраняются.
import { cn } from "@/components/ui/cn";

/** Отображает локальный DEV знак с переданным классом размера и оформления. */
export function BraiBrandIcon({ className }: { className?: string }) {
  return <img src="/icons/dev/Icon-192.png" width="192" height="192" alt="" aria-hidden="true" draggable={false} className={cn("block size-5 shrink-0", className)} />;
}
