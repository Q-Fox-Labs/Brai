"use client";
// ABOUTME: Сохраняет уведомление задачника September.
// ABOUTME: Не выполняет сетевых запросов и не хранит сообщения после закрытия.

type ErrorToastProps = {
  message: string;
  onClose: () => void;
};

/** Показывает исходное уведомление интерфейса и закрывает его по команде пользователя. */
export default function ErrorToast({ message, onClose }: ErrorToastProps) {
  if (!message) return null;

  return (
    <div className="fixed right-4 bottom-4 left-4 z-[1000] mx-auto flex w-[min(560px,calc(100%-32px))] items-center justify-between gap-3.5 rounded-xl border border-[#a63828] bg-[#b93f2a] py-3 pr-3 pl-4 text-[13px] leading-[1.4] text-white shadow-[0_12px_28px_rgba(25,27,25,0.2)]" role="alert" aria-live="assertive">
      <span>{message}</span>
      <button className="size-7 shrink-0 rounded-[7px] border-0 bg-transparent text-[24px] leading-none font-light text-inherit hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white/80" type="button" aria-label="Закрыть уведомление" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
