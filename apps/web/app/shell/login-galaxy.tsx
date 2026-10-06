"use client";
// ABOUTME: Показывает анимированный фон входа только при доступном WebGL и обычном движении.
// ABOUTME: Ограничивает декоративный фон экраном входа без изменения состояния и запросов auth.
import { useEffect, useRef, useState } from "react";
import Galaxy from "@/components/ui/galaxy";

/** Оставляет спокойный тёмный фон при reduced motion или недоступном WebGL. */
export function LoginGalaxy() {
  const host = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const canvas = document.createElement("canvas");
    let context: WebGLRenderingContext | WebGL2RenderingContext | null = null;
    try { context = canvas.getContext("webgl2") ?? canvas.getContext("webgl"); } catch { context = null; }
    const webglAvailable = Boolean(context);
    context?.getExtension("WEBGL_lose_context")?.loseContext();

    const onMotionChange = () => setEnabled(webglAvailable && !reducedMotion.matches);
    const onContextLost = () => setEnabled(false);
    const onContextRestored = () => setEnabled(webglAvailable && !reducedMotion.matches);
    const element = host.current;
    setEnabled(webglAvailable && !reducedMotion.matches);
    reducedMotion.addEventListener("change", onMotionChange);
    element?.addEventListener("webglcontextlost", onContextLost, true);
    element?.addEventListener("webglcontextrestored", onContextRestored, true);
    return () => {
      reducedMotion.removeEventListener("change", onMotionChange);
      element?.removeEventListener("webglcontextlost", onContextLost, true);
      element?.removeEventListener("webglcontextrestored", onContextRestored, true);
    };
  }, []);

  return <div ref={host} className="brai-login-galaxy-host" aria-hidden="true">{enabled && <Galaxy className="brai-login-galaxy" density={2} glowIntensity={0.2} hueShift={140} saturation={0} rotationSpeed={0.1} speed={1} starSpeed={1} twinkleIntensity={0.3} mouseInteraction={false} transparent />}</div>;
}
