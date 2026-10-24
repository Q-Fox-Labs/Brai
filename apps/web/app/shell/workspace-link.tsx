"use client";
// ABOUTME: Переключает уже смонтированные рабочие экраны без серверного перехода.
// ABOUTME: Сохраняет адрес, Back/Forward и обычное открытие ссылки в новой вкладке.
import type { ComponentProps, MouseEvent } from "react";

type WorkspacePath = "/" | "/agent" | "/do" | "/alerts" | "/game-core";

/** Меняет адрес рабочего раздела без сетевого перехода; Next синхронизирует usePathname. */
export function navigateWorkspace(href: WorkspacePath) {
  if (window.location.pathname !== href) window.history.pushState(null, "", href);
}

/** Сохраняет поведение ссылки с модификаторами; обычный клик переключает текущую оболочку. */
export default function WorkspaceLink({ href, onClick, ...props }: ComponentProps<"a"> & { href: WorkspacePath }) {
  function navigate(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
      || props.download !== undefined || (props.target && props.target !== "_self")) return;
    event.preventDefault();
    navigateWorkspace(href);
  }
  return <a {...props} href={href} onClick={navigate} />;
}
