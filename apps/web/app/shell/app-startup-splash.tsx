// ABOUTME: Переносит чёрную заставку с логотипом и бликом из Brai-old.
// ABOUTME: Отображается сервером до готовности страницы, без искусственной задержки входа.
import { GlareHover } from "@/components/ui/glare-hover";

const startupCss = `
@keyframes brai-startup-logo-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes brai-startup-logo-glare {
  from { transform: translateX(-180%) rotate(18deg); }
  to { transform: translateX(250%) rotate(18deg); }
}
.brai-startup-glare > div:last-child > div {
  animation: brai-startup-logo-glare 1000ms linear 1000ms both;
}
@media (prefers-reduced-motion: reduce) {
  [data-startup-logo], .brai-startup-glare > div:last-child > div { animation: none !important; }
}
`;

/** Показывает исходную заставку, пока сервер готовит новый документ. */
export function AppStartupSplash() {
  return <>
    <style>{startupCss}</style>
    <div className="fixed inset-0 z-[9999] grid place-items-center bg-black" data-startup-splash role="status" aria-label="Brai">
      <div data-startup-logo style={{ width: "min(20rem, calc(100vw - 3rem))", aspectRatio: "779 / 368", animation: "brai-startup-logo-fade 1000ms linear both" }}>
        <GlareHover width="100%" height="100%" background="transparent" borderColor="transparent" borderRadius="0" glareAngle={18} glareOpacity={1} glareSize={64} glareMaskImage="/brand/brai-logo-transparent.svg" transitionDuration={1000} interactive={false} playOnce className="brai-startup-glare border-0">
          {/* Нативное изображение сохраняет геометрию и декодирование исходной заставки. */}
          <img className="block h-full w-full select-none object-contain" src="/brand/brai-logo-transparent.svg" alt="Brai" width="779" height="368" decoding="sync" fetchPriority="high" draggable={false} />
        </GlareHover>
      </div>
    </div>
  </>;
}
