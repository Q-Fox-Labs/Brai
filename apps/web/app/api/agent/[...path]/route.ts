// ABOUTME: Публикует HTTP/SSE маршруты закрытой границы agent v2.
// ABOUTME: Проверки аккаунта, Origin, размера и транспорта принадлежат agent-http.
/** Передаёт чтение или явную мутацию авторизующему handler-у. */
export { agentGet as GET, agentPost as POST } from "@/server/agent-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
