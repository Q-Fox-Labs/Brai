// ABOUTME: Подтверждает запуск общей веб-программы без чтения пользовательских данных.
// ABOUTME: Готовность внешних сервисов проверяют их собственные health probes.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const readinessHeaders = {
  "Cache-Control": "no-store",
  "X-Brai-Web-Readiness": "1",
};

/** Отвечает только за работоспособность установленного веб-пакета. */
export function GET(): Response {
  return Response.json({ready: true, component: "web"}, {headers: readinessHeaders});
}

/** Позволяет оператору проверить Web за закрытым публичным входом. */
export function HEAD(): Response {
  return new Response(null, {
    headers: {...readinessHeaders, "Content-Type": "application/json"},
  });
}
