// ABOUTME: Объясняет отказ Brai выполнить клиентский инструмент Codex.
// ABOUTME: Показывает только имя и источник; не утверждает результат другого клиента.
import type { PendingRequest } from "@brai/agent/contracts";

/** Показывает безопасные метаданные нового запроса; старое уведомление допускает пустые params. */
export default function RequestNotice({ request }: { request: PendingRequest }) {
  const { tool, namespace } = request.params;
  const named = typeof tool === "string" && /^[\w-]{1,64}$/.test(tool);
  const scoped = typeof namespace === "string" && /^[\w-]{1,64}$/.test(namespace);
  const name = named ? `${scoped ? namespace + "." : ""}${tool}` : null;
  return <>
    <p><strong>Brai не поддерживает этот инструмент</strong></p>
    <p>{name ? <>Инструмент: <code>{name}</code></> : "Codex запросил выполнение инструмента. Его имя недоступно в этом уведомлении."}</p>
    {namespace === "codex_app" && <p>Источник: приложение Codex.{tool === "list_artifacts" && " Просмотр артефактов приложения Codex."}</p>}
    <p>Brai отправил отказ. Другой подключённый клиент Codex мог обработать запрос; итог выполнения здесь неизвестен.</p>
    <p>Отвечать не нужно. Если агент продолжает работу, уведомление можно скрыть.</p>
  </>;
}
