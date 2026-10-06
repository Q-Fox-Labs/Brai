"use client"

import * as React from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"

import { cn } from "@/components/ui/cn"

function ScrollArea({
  className,
  children,
  contentInset = "end",
  scrollbar = true,
  type = "always",
  scrollHideDelay = 1000,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  contentInset?: "balanced" | "end" | "none"
  scrollbar?: boolean
}) {
  const [scrollbarVisible, setScrollbarVisible] = React.useState(false)
  const hideTimerRef = React.useRef<number | null>(null)
  const viewportRef = React.useRef<HTMLDivElement | null>(null)

  const showScrollbar = React.useCallback(() => {
    if (!scrollbar) return
    const viewport = viewportRef.current
    if (viewport && viewport.scrollHeight <= viewport.clientHeight && viewport.scrollWidth <= viewport.clientWidth) return
    setScrollbarVisible(true)
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = window.setTimeout(() => setScrollbarVisible(false), scrollHideDelay)
  }, [scrollHideDelay, scrollbar])

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !scrollbar) return undefined
    viewport.addEventListener("scroll", showScrollbar, { passive: true })
    return () => viewport.removeEventListener("scroll", showScrollbar)
  }, [scrollbar, showScrollbar])

  React.useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current)
    }
  }, [])

  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      type={type}
      scrollHideDelay={scrollHideDelay}
      className={cn(
        "relative [--scroll-area-content-gutter:calc(var(--scroll-area-thumb-size)+var(--scroll-area-gap)+var(--scroll-area-gap))] [--scroll-area-gap:calc(var(--scroll-area-thumb-size)/2)] [--scroll-area-thumb-size:10px] max-[860px]:[--scroll-area-content-gutter:var(--scroll-area-thumb-size)] max-[860px]:[--scroll-area-gap:0px]",
        scrollbar && contentInset !== "none" && "[&>[data-slot=scroll-area-viewport]]:pr-[var(--scroll-area-content-gutter)]",
        scrollbar && contentInset === "balanced" && "[&>[data-slot=scroll-area-viewport]]:pl-[var(--scroll-area-content-gutter)]",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        ref={viewportRef}
        className={cn(
          "size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
          !scrollbar && "!overflow-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
        onWheelCapture={showScrollbar}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {scrollbar ? <ScrollBar visible={scrollbarVisible} /> : null}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  style,
  visible = false,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar> & { visible?: boolean }) {
  const edgeStyle = orientation === "vertical" ? { right: "var(--scroll-area-gap)" } : { bottom: "var(--scroll-area-gap)" }
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-scrollbar-state={visible ? "visible" : "hidden"}
      orientation={orientation}
      style={{ ...edgeStyle, ...style }}
      className={cn(
        "flex touch-none transition-[opacity,background-color,border-color] select-none",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
        orientation === "vertical" &&
          "h-full w-[var(--scroll-area-thumb-size)] border-l border-l-transparent",
        orientation === "horizontal" &&
          "h-[var(--scroll-area-thumb-size)] flex-col border-t border-t-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
