// ABOUTME: Направляет пользователя в рабочий чат Brai в Telegram.
// ABOUTME: Не запускает прежний DEV Agent-клиент или его фоновые запросы.

/** Объясняет, где продолжить разговор с Hermes в Telegram. */
export default function TelegramAgentEntry({ username }: { username: string | null }) {
  return <main className="mx-auto flex h-full w-full max-w-3xl items-center justify-center p-6 sm:p-10">
    <section className="w-full rounded-2xl border bg-card p-8 text-card-foreground shadow-sm sm:p-10">
      <p className="text-sm font-medium text-muted-foreground">Brai Agent</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Продолжайте в Telegram</h1>
      <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">Откройте рабочий чат Brai в Telegram и отправьте сообщение боту{username ? ` @${username}` : ""}. Hermes продолжит разговор в этом чате.</p>
    </section>
  </main>;
}
