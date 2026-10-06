"use client";
// ABOUTME: Закрывает первый показ любого маршрута исходной заставкой Brai-old.
// ABOUTME: Ждёт гидратацию, ресурсы, шрифты и явно заявленные первоначальные чтения.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppStartupSplash } from "./app-startup-splash";

export const STARTUP_MIN_VISIBLE_MS = 3000;
const StartupContext = createContext<{ register: () => () => void } | null>(null);

/** Общая граница живёт весь документ: последующие переходы и обновления её не возвращают. */
export function AppStartupBoundary({ children }: { children: ReactNode }) {
  const [complete, setComplete] = useState(false);
  const [assetsReady, setAssetsReady] = useState(false);
  const [introReady, setIntroReady] = useState(false);
  const [pending, setPending] = useState(0);
  const register = useCallback(() => {
    setPending(count => count + 1);
    let released = false;
    return () => { if (!released) { released = true; setPending(count => count - 1); } };
  }, []);
  const context = useMemo(() => complete ? null : { register }, [complete, register]);

  useEffect(() => {
    let alive = true;
    const startedAt = (window as Window & { __braiStartupStartedAt?: number }).__braiStartupStartedAt ?? performance.now();
    const intro = setTimeout(() => setIntroReady(true), Math.max(0, STARTUP_MIN_VISIBLE_MS - (performance.now() - startedAt)));
    let loaded = () => {};
    const documentLoaded = new Promise<void>(resolve => {
      loaded = resolve;
      if (document.readyState === "complete") resolve();
      else window.addEventListener("load", loaded, { once: true });
    });
    void Promise.all([documentLoaded, document.fonts.ready]).then(() => { if (alive) setAssetsReady(true); });
    return () => { alive = false; clearTimeout(intro); window.removeEventListener("load", loaded); };
  }, []);

  useEffect(() => {
    if (complete || !introReady || !assetsReady || pending !== 0) return;
    // ResizeObserver и измеряющие цифры/панели компоненты получают кадр после загрузки шрифтов.
    let alive = true, first = 0, second = 0;
    void document.fonts.ready.then(() => {
      if (alive) first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setComplete(true)); });
    });
    return () => { alive = false; cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [complete, introReady, assetsReady, pending]);

  return <StartupContext.Provider value={context}>
    {!complete && <AppStartupSplash />}
    <div data-startup-content style={{ display: "contents", visibility: complete ? "visible" : "hidden" }} inert={!complete} aria-hidden={complete ? undefined : true}>{children}</div>
  </StartupContext.Provider>;
}

/** Дополняет общую готовность документа первым чтением; после открытия экрана ничего не блокирует. */
export function useStartupReady(ready: boolean) {
  const startup = useContext(StartupContext);
  useEffect(() => {
    if (ready || !startup) return;
    return startup.register();
  }, [ready, startup]);
}
