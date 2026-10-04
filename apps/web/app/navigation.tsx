"use client";
// ABOUTME: Показывает общие вкладки «Агент», «Таймер» и «Дела» над рабочими экранами.
// ABOUTME: Получает локальный отсчёт явно и восстанавливает заголовок после его завершения.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/** Отображает навигацию страниц с доступным обозначением активной вкладки. */
export default function Navigation({ timerElapsed }: { timerElapsed: string | null }) {
  const pathname = usePathname();
  const originalTitle = useRef("Brai");
  useEffect(() => {
    originalTitle.current = document.title;
    return () => { document.title = originalTitle.current; };
  }, []);
  useEffect(() => {
    document.title = timerElapsed ? `${timerElapsed} · ${originalTitle.current}` : originalTitle.current;
  }, [timerElapsed]);
  return <header className="workspace-header">
    <span className="workspace-brand">Brai</span>
    <nav className="workspace-tabs" aria-label="Разделы Brai">
      <Link href="/agent" aria-current={pathname === "/agent" ? "page" : undefined}>Агент</Link>
      <Link className="workspace-timer-tab" href="/" aria-current={pathname === "/" ? "page" : undefined}><span>Таймер</span>{timerElapsed && <span className="workspace-timer-countdown" aria-label={`Идёт отсчёт ${timerElapsed}`}>{timerElapsed}</span>}</Link>
      <Link href="/do" aria-current={pathname === "/do" ? "page" : undefined}>Дела</Link>
    </nav>
  </header>;
}
