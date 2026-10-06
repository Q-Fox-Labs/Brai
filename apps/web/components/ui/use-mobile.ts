// ABOUTME: Определяет мобильную ширину окна для общих UI-компонентов.
// ABOUTME: Не читает состояние приложения и не меняет разметку.
import * as React from "react"

const MOBILE_BREAKPOINT = 861

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(false)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    const timeout = window.setTimeout(onChange, 0)
    return () => {
      window.clearTimeout(timeout)
      mql.removeEventListener("change", onChange)
    }
  }, [])

  return isMobile
}
