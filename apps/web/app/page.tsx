// ABOUTME: Показывает минимальную страницу веб-приложения Brai.
// ABOUTME: Оставляет пользовательские сценарии следующим задачам.
import * as Separator from "@radix-ui/react-separator";

/** Отображает стартовую страницу без прикладного поведения. */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-4xl font-semibold tracking-tight">Brai</h1>
      <Separator.Root className="h-px w-full bg-slate-200" decorative />
      <p className="text-lg text-slate-600">Веб-приложение готово к разработке.</p>
    </main>
  );
}
