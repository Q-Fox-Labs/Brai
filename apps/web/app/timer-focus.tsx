"use client";
// ABOUTME: Отображает крупный экран таймера и выбор анимированного фона.
// ABOUTME: Время приходит из модели Timer; декоративные эффекты отключаются при reduced motion и без WebGL.
import { useEffect, useState, type RefObject } from "react";
import { ChevronDown, Eye, Sparkles } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { BorderTrail } from "@/components/ui/border-trail";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import EvilEye from "@/components/ui/EvilEye/EvilEye";
import Galaxy from "@/components/ui/galaxy";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SlidingNumber } from "@/components/ui/sliding-number";
import { TextMorph } from "@/components/ui/text-morph";

export type TimerBackgroundMode = "galaxy" | "evil-eye";

const TIMER_GALAXY_IDLE = {
  density: 0.5,
  glowIntensity: 0.2,
  saturation: 0,
  hueShift: 140,
  twinkleIntensity: 0,
  rotationSpeed: 0,
  repulsionStrength: 1,
  autoCenterRepulsion: 0,
  starSpeed: 0.1,
  speed: 0.3,
  mouseRepulsion: false,
  mouseInteraction: false,
};

const TIMER_GALAXY_ACTIVE = {
  ...TIMER_GALAXY_IDLE,
  density: 2,
  twinkleIntensity: 0.3,
  rotationSpeed: 0.1,
  repulsionStrength: 2.5,
  starSpeed: 1,
  speed: 1,
};

const TIMER_EVIL_EYE_IDLE = { flameSpeed: 0.25, scale: 0.4 };
const TIMER_EVIL_EYE_ACTIVE = { flameSpeed: 1, scale: 0.8 };
const FOCUS_BACKGROUND_BLOCK_SELECTOR = "[data-timer-interaction-block], button, a, input, textarea, select, [role='button'], [role='slider']";

/** Показывает экран фокуса по монотонной длительности и команде владельца таймера. */
export default function TimerFocus({
  elapsedMs,
  elapsedText,
  active,
  sessionKey,
  centered,
  startedAt,
  message,
  background,
  effectsAvailable,
  onBackground,
  onToggle,
}: {
  elapsedMs: number;
  elapsedText: string;
  active: boolean;
  sessionKey: string | null;
  centered: boolean;
  startedAt: string | null;
  message: string;
  background: TimerBackgroundMode;
  effectsAvailable: boolean;
  onBackground: (mode: TimerBackgroundMode) => void;
  onToggle: () => void;
}) {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;

  return (
    <section className={`timer-focus${centered ? " is-centered" : ""}`} aria-label="Фокус">
      <ScrollArea
        scrollbar={false}
        className="timer-focus-scroll relative z-10 h-full min-h-0 min-w-0 w-full [&>[data-slot=scroll-area-viewport]]:scroll-pb-36 [&>[data-slot=scroll-area-viewport]>div]:h-full"
        data-nav-swipe-exclusion
      >
        <div className={`timer-screen${centered ? " is-centered" : ""}${active ? " is-active" : ""}`}>
          <div className="timer-primary">
            <Card className={`timer-face${centered ? " is-centered" : ""}${active ? " is-active" : ""}`}>
              {active && effectsAvailable && (
                <BorderTrail
                  className="timer-border-trail"
                  style={{
                    boxShadow:
                      "0px 0px 60px 30px rgb(255 255 255 / 50%), 0 0 100px 60px rgb(0 0 0 / 50%), 0 0 140px 90px rgb(0 0 0 / 50%)",
                  }}
                  size={100}
                  transition={{ repeat: Infinity, duration: 10, ease: "linear" }}
                />
              )}
              <div
                key={sessionKey ?? (active ? "running" : "idle")}
                className={`timer-digits${centered ? " is-centered" : ""}`}
                role="timer"
                aria-label={elapsedText}
                aria-live="off"
              >
                <span aria-hidden="true" className="timer-digits-row">
                  <span data-slot="timer-hours"><SlidingNumber value={hours} padStart instant={!active || !effectsAvailable} snapKey={totalSeconds} /></span>
                  <span>:</span>
                  <span data-slot="timer-minutes"><SlidingNumber value={minutes} padStart instant={!active || !effectsAvailable} snapKey={totalSeconds} /></span>
                  <span>:</span>
                  <span data-slot="timer-seconds"><SlidingNumber value={seconds} padStart instant={!active || !effectsAvailable} snapKey={totalSeconds} /></span>
                </span>
              </div>
            </Card>
            <div className="timer-scroll-hint" aria-hidden="true">
              {effectsAvailable ? (
                <AnimatePresence initial={false}>
                  {!active ? (
                    <motion.div
                      className="timer-scroll-hint-icon"
                      initial={{ opacity: 0, y: -2, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.96 }}
                      transition={{ duration: 0.22, ease: "easeOut" }}
                    >
                      <ChevronDown aria-hidden="true" />
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              ) : !active ? <ChevronDown /> : null}
            </div>
          </div>

          <div className="timer-actions" data-timer-interaction-block>
            <p className={`timer-session-line${active ? "" : " is-hidden"}`} aria-hidden={!active}>
              {active && startedAt ? `Started ${formatStartedAt(startedAt)}` : "\u00a0"}
            </p>
            <Button
              type="button"
              variant={active ? "destructive" : "default"}
              className="timer-action-button"
              onClick={onToggle}
              aria-label={active ? "Завершить таймер" : "Запустить таймер"}
            >
              {effectsAvailable
                ? <TextMorph as="span">{active ? "Завершить" : "Запустить"}</TextMorph>
                : <span>{active ? "Завершить" : "Запустить"}</span>}
            </Button>
            <div className="timer-background-toggle" role="group" aria-label="Фон фокуса">
              <Button
                type="button"
                size="icon"
                variant="outline"
                aria-label="Фон Galaxy"
                aria-pressed={background === "galaxy"}
                onClick={() => onBackground("galaxy")}
              >
                <Sparkles aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="outline"
                aria-label="Фон Evil Eye"
                aria-pressed={background === "evil-eye"}
                onClick={() => onBackground("evil-eye")}
              >
                <Eye aria-hidden="true" />
              </Button>
            </div>
            {message && <p className="timer-message" role="status" aria-live="polite">{message}</p>}
          </div>
        </div>
      </ScrollArea>
    </section>
  );
}

/** Включает декор только для видимой вкладки и viewport, если motion и WebGL доступны. */
export function useTimerEffectsAvailable(viewportRef: RefObject<HTMLElement | null>) {
  const [effectsAvailable, setEffectsAvailable] = useState(false);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      const isVisible = !viewport.closest("[hidden]") && viewport.getClientRects().length > 0;
      setEffectsAvailable(isVisible && document.visibilityState === "visible" && !motionPreference.matches && supportsWebGL());
    };
    update();
    motionPreference.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    const visibilityObserver = new IntersectionObserver(update);
    visibilityObserver.observe(viewport);
    const hiddenObserver = new MutationObserver(update);
    hiddenObserver.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["hidden"] });
    return () => {
      motionPreference.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
      visibilityObserver.disconnect();
      hiddenObserver.disconnect();
    };
  }, [viewportRef]);

  return effectsAvailable;
}

/** Рисует выбранный декоративный фон в пределах локального viewport таймера. */
export function FocusBackground({
  active,
  mode,
  animated,
}: {
  active: boolean;
  mode: TimerBackgroundMode;
  animated: boolean;
}) {
  const [transition, setTransition] = useState<{ mode: TimerBackgroundMode; previous: TimerBackgroundMode | null }>({ mode, previous: null });
  let currentTransition = transition;

  if (currentTransition.mode !== mode) {
    currentTransition = { mode, previous: currentTransition.mode };
    setTransition(currentTransition);
  }

  useEffect(() => {
    if (transition.previous === null) return;
    const timeoutId = window.setTimeout(() => {
      setTransition(current => current.mode === transition.mode ? { mode: current.mode, previous: null } : current);
    }, 3000);
    return () => window.clearTimeout(timeoutId);
  }, [transition.mode, transition.previous]);

  const renderedModes = currentTransition.previous === null
    ? [currentTransition.mode]
    : [currentTransition.previous, currentTransition.mode];
  const galaxyProps = active ? TIMER_GALAXY_ACTIVE : TIMER_GALAXY_IDLE;
  const evilEyeProps = active ? TIMER_EVIL_EYE_ACTIVE : TIMER_EVIL_EYE_IDLE;

  return (
    <div className={`timer-focus-background ${mode === "evil-eye" ? "is-evil-eye" : "is-galaxy"}`} aria-hidden="true">
      {animated && renderedModes.includes("galaxy") && (
        <div className={`timer-galaxy-background${currentTransition.mode === "galaxy" ? " is-visible" : ""}`}>
          <Galaxy {...galaxyProps} interactionBlockSelector={FOCUS_BACKGROUND_BLOCK_SELECTOR} />
        </div>
      )}
      {animated && renderedModes.includes("evil-eye") && (
        <div className={`timer-evil-eye-background${currentTransition.mode === "evil-eye" ? " is-visible" : ""}`}>
          <EvilEye {...evilEyeProps} interactionBlockSelector={FOCUS_BACKGROUND_BLOCK_SELECTOR} />
        </div>
      )}
    </div>
  );
}

function formatStartedAt(value: string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(date);
}

let webGLAvailable: boolean | null = null;

function supportsWebGL() {
  if (webGLAvailable !== null) return webGLAvailable;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!context) return (webGLAvailable = false);
    const extension = context.getExtension("WEBGL_lose_context");
    extension?.loseContext();
    return (webGLAvailable = true);
  } catch {
    return (webGLAvailable = false);
  }
}
