// ABOUTME: Подтверждает запуск общей веб-программы без чтения пользовательских данных.
// ABOUTME: Готовность внешних сервисов проверяют их собственные health probes.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Отвечает только за работоспособность установленного веб-пакета. */
export function GET(): Response {
 return Response.json({ready: true}, {headers: {"Cache-Control": "no-store"}});
}
