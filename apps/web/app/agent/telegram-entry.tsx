// ABOUTME: Направляет workspace Agent к текущему Hermes Telegram-боту.
// ABOUTME: Не запускает прежний DEV Agent-клиент или его фоновые запросы.
import { Button } from "@/components/ui/button";

/** Показывает ссылку на настроенного Hermes-бота в том же разделе приложения. */
export default function TelegramAgentEntry({ username }: { username: string | null }) {
  return <main className="mx-auto flex h-full w-full max-w-3xl items-center justify-center p-6 sm:p-10">
    <section className="w-full rounded-2xl border bg-card p-8 text-card-foreground shadow-sm sm:p-10">
      <p className="text-sm font-medium text-muted-foreground">Brai Agent</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Продолжайте в Telegram</h1>
      <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">Hermes работает через Telegram. Откройте тот же бот, чтобы отправить сообщение и продолжить разговор.</p>
      {username
        ? <Button asChild size="lg" className="mt-6"><a href={`https://t.me/${username}`} target="_blank" rel="noopener noreferrer">Открыть @{username} в Telegram</a></Button>
        : <p className="mt-6 text-sm text-muted-foreground" role="status">Ссылка на Telegram-бот пока не настроена.</p>}
    </section>
  </main>;
}
