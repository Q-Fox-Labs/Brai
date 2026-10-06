"use client";
// ABOUTME: Подключает desktop и mobile shell Brai к активному маршруту.
// ABOUTME: Обновляет заголовок вкладки по таймеру и передаёт профильные действия оболочке.
import { useEffect, useRef } from "react";
import AppNavigation from "./shell/app-navigation";

/** Отображает навигацию Brai и сохраняет отсчёт в заголовке вкладки. */
export default function Navigation({ timerElapsed, email, onLogout }: {
  timerElapsed: string | null;
  email: string;
  onLogout: () => void;
}) {
  const originalTitle = useRef("Brai");
  useEffect(() => {
    originalTitle.current = document.title;
    return () => { document.title = originalTitle.current; };
  }, []);
  useEffect(() => {
    document.title = timerElapsed ? timerElapsed + " · " + originalTitle.current : originalTitle.current;
  }, [timerElapsed]);
  return <AppNavigation email={email} timerElapsed={timerElapsed} onLogout={onLogout} />;
}
