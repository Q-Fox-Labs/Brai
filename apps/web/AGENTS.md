<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Рабочая оболочка

Рабочие разделы используют общую оболочку Brai: узкое главное меню и верхняя
полоса расположены снаружи одного скруглённого рабочего тела. Рейл, основная
область и правая панель находятся внутри него и разделены тонкими границами.

Содержимое страницы передаётся в `WorkspaceFrame`; не создавай повторно рамку,
перетаскиваемые разделители или управление панелями на отдельных страницах.
Заголовки и вкладки правой панели расположены во внешней верхней полосе.
Главное меню остаётся слева, а каждая область прокручивается независимо.
При недостатке ширины боковые панели открываются временно поверх тела.
Экран входа и публичные страницы не используют рабочую оболочку.
