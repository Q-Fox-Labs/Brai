"use client";
// ABOUTME: Показывает общие вкладки «Агент», «Таймер» и «Дела» над рабочими экранами.
// ABOUTME: Использует клиентские переходы Next.js и отмечает текущий маршрут.
import Link from "next/link";
import { usePathname } from "next/navigation";

/** Отображает навигацию страниц с доступным обозначением активной вкладки. */
export default function Navigation() {
  const pathname = usePathname();
  return <header className="workspace-header">
    <span className="workspace-brand">Brai</span>
    <nav className="workspace-tabs" aria-label="Разделы Brai">
      <Link href="/agent" aria-current={pathname === "/agent" ? "page" : undefined}>Агент</Link>
      <Link href="/" aria-current={pathname === "/" ? "page" : undefined}>Таймер</Link>
      <Link href="/do" aria-current={pathname === "/do" ? "page" : undefined}>Дела</Link>
    </nav>
  </header>;
}
