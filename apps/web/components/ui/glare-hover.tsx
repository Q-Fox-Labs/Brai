"use client";

import { useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from "react";

export type GlareHoverProps = {
  width?: string;
  height?: string;
  background?: string;
  borderRadius?: string;
  borderColor?: string;
  children?: ReactNode;
  glareColor?: string;
  glareOpacity?: number;
  glareAngle?: number;
  glareSize?: number;
  glareMaskImage?: string;
  transitionDuration?: number;
  playOnce?: boolean;
  autoPlayDelayMs?: number;
  interactive?: boolean;
  className?: string;
  style?: CSSProperties;
};

export function GlareHover({
  width = "500px",
  height = "500px",
  background = "#000",
  borderRadius = "10px",
  borderColor = "#333",
  children,
  glareColor = "#ffffff",
  glareOpacity = 0.5,
  glareAngle = 18,
  glareSize = 64,
  glareMaskImage,
  transitionDuration = 650,
  playOnce = false,
  autoPlayDelayMs,
  interactive = true,
  className = "",
  style = {},
}: GlareHoverProps) {
  const hex = glareColor.replace("#", "");
  let rgba = glareColor;
  if (/^[\dA-Fa-f]{6}$/.test(hex)) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    rgba = `rgba(${r}, ${g}, ${b}, ${glareOpacity})`;
  } else if (/^[\dA-Fa-f]{3}$/.test(hex)) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    rgba = `rgba(${r}, ${g}, ${b}, ${glareOpacity})`;
  }

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const startTransform = `translateX(-180%) rotate(${glareAngle}deg)`;
  const endTransform = `translateX(250%) rotate(${glareAngle}deg)`;

  const animateIn = useCallback(() => {
    const el = overlayRef.current;
    if (!el) return;

    el.style.transition = "none";
    el.style.transform = startTransform;
    void el.offsetWidth;
    el.style.transition = `transform ${transitionDuration}ms linear`;
    el.style.transform = endTransform;
  }, [endTransform, startTransform, transitionDuration]);

  const animateOut = useCallback(() => {
    const el = overlayRef.current;
    if (!el) return;

    if (playOnce) {
      el.style.transition = "none";
      el.style.transform = startTransform;
    } else {
      el.style.transition = `transform ${transitionDuration}ms linear`;
      el.style.transform = startTransform;
    }
  }, [playOnce, startTransform, transitionDuration]);

  useEffect(() => {
    if (autoPlayDelayMs == null) return undefined;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const timeout = window.setTimeout(animateIn, autoPlayDelayMs);
    return () => window.clearTimeout(timeout);
  }, [animateIn, autoPlayDelayMs]);

  const maskStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    ...(glareMaskImage
      ? {
          WebkitMaskImage: `url(${glareMaskImage})`,
          WebkitMaskPosition: "center",
          WebkitMaskRepeat: "no-repeat",
          WebkitMaskSize: "contain",
          maskImage: `url(${glareMaskImage})`,
          maskPosition: "center",
          maskRepeat: "no-repeat",
          maskSize: "contain",
        }
      : {}),
  };
  const beamStyle: CSSProperties = {
    position: "absolute",
    top: "-45%",
    left: 0,
    width: `${glareSize}%`,
    height: "190%",
    background: `linear-gradient(90deg,
        hsla(0,0%,100%,0) 0%,
        ${rgba} 42%,
        #fff 50%,
        ${rgba} 58%,
        hsla(0,0%,100%,0) 100%)`,
    filter: "blur(0.35px) drop-shadow(0 0 12px rgba(255,255,255,0.55))",
    mixBlendMode: "screen",
    transform: startTransform,
    transformOrigin: "center",
    willChange: "transform",
  };

  return (
    <div
      className={`relative grid place-items-center overflow-hidden border ${interactive ? "cursor-pointer" : ""} ${className}`}
      style={{
        width,
        height,
        background,
        borderRadius,
        borderColor,
        ...style,
      }}
      onMouseEnter={interactive ? animateIn : undefined}
      onMouseLeave={interactive ? animateOut : undefined}
    >
      {children}
      <div style={maskStyle}>
        <div ref={overlayRef} style={beamStyle} />
      </div>
    </div>
  );
}

export default GlareHover;
