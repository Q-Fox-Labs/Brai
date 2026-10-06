"use client";
// ABOUTME: Показывает единый счётчик непрочитанных и цвет выбранной категории alerts.
// ABOUTME: Открытие ленты не меняет отметки; неизвестное число не отображается как ноль.
import type { MouseEvent } from "react";
import { Bell } from "lucide-react";
import Link from "../shell/workspace-link";
import { useAlerts } from "./provider";
/** Сохраняет native поведение ссылки и отображает 99+ при большем счётчике. */
export function AlertsBell({ onClick }: { onClick?: (event: MouseEvent<HTMLAnchorElement>) => void }) {
 const { summary, live, error } = useAlerts(), count = summary?.unread_count;
 const label = count === undefined ? "Уведомления, счётчик уточняется" : `Уведомления, непрочитанных: ${count}`;
 return <Link href="/alerts" onClick={onClick} className="brai-alerts-bell brai-theme-button" aria-label={label}
  title={label + (error || !live ? ". Обновление связи" : "")}>
  <Bell aria-hidden="true" />
  {count !== undefined && count > 0 && <span className="brai-alerts-badge" style={{ backgroundColor: summary?.category?.color, color: summary?.category ? badgeText(summary.category.color) : undefined }} aria-hidden="true">{count > 99 ? "99+" : count}</span>}
 </Link>;
}

function badgeText(color: string) {
 const rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255)
  .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
 // AIDEV-NOTE: Категорию настраивает владелец; светлый фон badge требует тёмного текста.
 return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2] > .179 ? "#000" : "#fff";
}
