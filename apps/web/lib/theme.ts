// ABOUTME: Предоставляет единый браузерный API текущей и сохранённой темы Brai.
// ABOUTME: Хранит только режим выбора и синхронизирует его с корневым элементом и вкладками.

"use client";

import { useSyncExternalStore } from "react";

export type ThemeMode = "system" | "light" | "dark";
export type ThemeAppearance = Exclude<ThemeMode, "system">;

const THEME_STORAGE_KEY = "brai_theme_mode";
const THEME_CHANGE_EVENT = "brai:themechange";
const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";

/** Возвращает сохранённый выбор темы; при отсутствии выбора использует системный режим. */
export function getThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "system";

  try {
    const savedMode = window.localStorage.getItem(THEME_STORAGE_KEY);
    return savedMode === "light" || savedMode === "dark" ? savedMode : "system";
  } catch {
    const appliedMode = document.documentElement.dataset.themeMode;
    return appliedMode === "light" || appliedMode === "dark" ? appliedMode : "system";
  }
}

/** Сохраняет режим темы, сразу обновляет оформление документа и уведомляет слушателей. */
export function setThemeMode(mode: ThemeMode): void {
  try {
    if (mode === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Браузеры с заблокированным хранилищем всё равно применяют тему в текущей вкладке.
  }

  applyThemeMode(mode);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

/** Подписывается на события, меняющие выбранный режим или системное оформление. */
function subscribeToThemeChanges(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const colorScheme = window.matchMedia(COLOR_SCHEME_QUERY);
  const handleSystemChange = () => {
    if (getThemeMode() === "system") {
      applyThemeMode("system");
      onChange();
    }
  };
  const handleStorageChange = (event: StorageEvent) => {
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    const mode = getThemeMode();
    applyThemeMode(mode);
    onChange();
  };

  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  window.addEventListener("storage", handleStorageChange);
  colorScheme.addEventListener("change", handleSystemChange);

  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", handleStorageChange);
    colorScheme.removeEventListener("change", handleSystemChange);
  };
}

/** Возвращает текущий выбор, фактический светлый или тёмный вид и обработчик переключателя. */
export function useThemeMode(): {
  mode: ThemeMode;
  theme: ThemeAppearance;
  onThemeChange: (theme: ThemeAppearance) => void;
} {
  const snapshot = useSyncExternalStore(subscribeToThemeChanges, getThemeSnapshot, getServerThemeSnapshot);
  const [mode, theme] = snapshot.split(":") as [ThemeMode, ThemeAppearance];

  return { mode, theme, onThemeChange: setThemeMode };
}

/** Возвращает неизменяемое представление режима и фактической палитры для подписчиков. */
function getThemeSnapshot(): string {
  const mode = getThemeMode();
  const systemIsDark = typeof window !== "undefined" && window.matchMedia(COLOR_SCHEME_QUERY).matches;
  const theme = mode === "dark" || (mode === "system" && systemIsDark) ? "dark" : "light";

  return `${mode}:${theme}`;
}

/** Даёт серверному и первому hydration-рендеру одинаковое безопасное значение. */
function getServerThemeSnapshot(): string {
  return "system:light";
}

/** Применяет разрешённую палитру до следующего отображённого кадра. */
function applyThemeMode(mode: ThemeMode): void {
  if (typeof document === "undefined") return;

  const systemIsDark = typeof window !== "undefined" && window.matchMedia(COLOR_SCHEME_QUERY).matches;
  const theme: ThemeAppearance = mode === "dark" || (mode === "system" && systemIsDark) ? "dark" : "light";
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themeMode = mode;
  root.classList.toggle("dark", theme === "dark");
}
