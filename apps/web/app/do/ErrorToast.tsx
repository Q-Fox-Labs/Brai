"use client";
// ABOUTME: Сохраняет уведомление задачника September.
// ABOUTME: Не выполняет сетевых запросов и не хранит сообщения после закрытия.

type ErrorToastProps = {
  message: string;
  onClose: () => void;
};
import { Button } from "@/components/ui/button";

/** Показывает исходное уведомление интерфейса и закрывает его по команде пользователя. */
export default function ErrorToast({ message, onClose }: ErrorToastProps) {
  if (!message) return null;

  return (
    <div className="fixed right-4 bottom-4 left-4 z-[1000] mx-auto flex w-[min(560px,calc(100%-32px))] items-center justify-between gap-3 rounded-xl border border-destructive bg-destructive py-3 pr-3 pl-4 text-sm leading-5 text-destructive-foreground shadow-lg" role="alert" aria-live="assertive">
      <span>{message}</span>
      <Button className="size-8 shrink-0 p-0 text-inherit hover:bg-destructive-foreground/10" variant="ghost" size="icon-sm" type="button" aria-label="Закрыть уведомление" onClick={onClose}>
        ×
      </Button>
    </div>
  );
}
