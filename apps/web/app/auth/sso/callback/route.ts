// ABOUTME: Завершает DEV SSO без загрузки оболочки приложения.
// ABOUTME: Удаляет fragment до сетевого запроса и не подключает внешние ресурсы.
import { createHash } from "node:crypto";
import { secureHeaders, ssoConfig } from "@/server/sso";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const script = `const p=new URLSearchParams(location.hash.slice(1));history.replaceState(null,"",location.pathname);const ticket=p.get("ticket");if(!ticket||p.size!==1){document.getElementById("status").textContent="Не удалось завершить вход. Начните заново."}else{fetch("/api/auth/sso/redeem",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ticket}),cache:"no-store"}).then(r=>{if(!r.ok)throw Error();location.replace("/")}).catch(()=>{document.getElementById("status").textContent="Не удалось завершить вход. Начните заново."})}`;
/** Возвращает изолированную страницу передачи ticket; URL не содержит его в запросе. */
export function GET(): Response {
 const config = ssoConfig();
 if (!config || config.role !== "preview") return new Response("SSO недоступен", { status: 404, headers: secureHeaders });
 const hash = createHash("sha256").update(script).digest("base64");
 return new Response(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Вход в Brai</title></head><body><main><p id="status" role="status">Завершаем вход…</p><a href="/api/auth/sso/start">Начать вход заново</a></main><script>${script}</script></body></html>`, { headers: { ...secureHeaders, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${hash}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` } });
}
