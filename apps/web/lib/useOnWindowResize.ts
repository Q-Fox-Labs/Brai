// ABOUTME: Выполняет переданный обработчик при изменении размера окна.
// ABOUTME: Используется локально графической легендой и очищает подписку при размонтировании.
"use client";

import * as React from "react";

export function useOnWindowResize(handler: () => void) {
  React.useEffect(() => {
    handler();
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [handler]);
}
