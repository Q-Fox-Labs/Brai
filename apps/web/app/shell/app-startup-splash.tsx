// ABOUTME: Показывает DEV знак Brai-Old в чёрной заставке с прежним бликом.
// ABOUTME: Отображается в корневой границе до готовности первого клиентского кадра.
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

/** Показывает DEV заставку, пока корневая граница готовит страницу. */
export function AppStartupSplash() {
  return <>
    <style>{startupCss}</style>
    <div className="fixed inset-0 z-[9999] grid place-items-center bg-black" style={{ position: "fixed", inset: 0, zIndex: 9999, display: "grid", placeItems: "center", background: "#000" }} data-startup-splash role="status" aria-label="Brai DEV">
      <div data-startup-logo style={{ width: "min(20rem, calc(100vw - 3rem))", aspectRatio: "779 / 368", animation: "brai-startup-logo-fade 1000ms linear both" }}>
        <GlareHover width="100%" height="100%" background="transparent" borderColor="transparent" borderRadius="0" glareAngle={18} glareOpacity={1} glareSize={64} glareMaskImage="/icons/dev/Icon-512.png" transitionDuration={1000} interactive={false} playOnce className="brai-startup-glare border-0">
          {/* Готовый DEV PNG сохраняет декодирование и размещение прежней заставки. */}
          <img className="block h-full w-full select-none object-contain" src="/icons/dev/Icon-512.png" alt="Brai DEV" width="512" height="512" decoding="sync" fetchPriority="high" draggable={false} />
        </GlareHover>
      </div>
    </div>
  </>;
}
