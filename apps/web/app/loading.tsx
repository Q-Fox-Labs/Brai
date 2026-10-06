// ABOUTME: Показывает заставку Brai-old при загрузке нового документа.
// ABOUTME: Родительская граница охватывает серверную подготовку рабочей оболочки и сессии.
import { AppStartupSplash } from "./shell/app-startup-splash";

/** Снимается Next автоматически, когда готово содержимое маршрута. */
export default function Loading() {
  return <AppStartupSplash />;
}
