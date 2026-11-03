// ABOUTME: Проверяет DEV-настройку SSO и параметры одноразового перехода.
// ABOUTME: Не доверяет Host и не разрешает произвольные адреса продолжения.
import { createHash, randomBytes } from "node:crypto";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export const stateCookie = "__Host-brai-sso";
export const secureHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

type SsoConfig = { origin: string; hub: string; previews: string[]; role: "hub" | "preview" };
function origin(value: string | undefined): string | null {
 try { const url = new URL(value ?? ""); return url.protocol === "https:" && url.origin === value && !url.username && !url.password ? url.origin : null; } catch { return null; }
}
/** Включает SSO только для полного набора точных HTTPS origin в DEV. */
export function ssoConfig(): SsoConfig | null {
 if (process.env.BRAI_ENVIRONMENT !== "dev") return null;
 const own = origin(process.env.WEB_ORIGIN), hub = origin(process.env.WEB_SSO_HUB_ORIGIN);
 const raw = process.env.WEB_SSO_PREVIEW_ORIGINS;
 if (!own || !hub || !raw) return null;
 const previews = raw.split(",").map(item => origin(item.trim()));
 if (!previews.length || previews.some(item => !item || item === hub) || new Set(previews).size !== previews.length) return null;
 const role = own === hub ? "hub" : previews.includes(own) ? "preview" : null;
 return role ? { origin: own, hub, previews: previews as string[], role } : null;
}
/** Проверяет только локальный authorize с разрешённым назначением и challenge. */
export function continuation(params: URLSearchParams, config: SsoConfig | null): string | null {
 if (!config || config.role !== "hub") return null;
 const target = params.get("targetOrigin"), challenge = params.get("challenge");
 if (params.size !== 2 || !target || !config.previews.includes(target) || !challenge || !tokenPattern.test(challenge)) return null;
 return `/api/auth/sso/authorize?${new URLSearchParams({ targetOrigin: target, challenge })}`;
}
/** Создаёт verifier и его SHA-256 challenge для связывания перехода с браузером. */
export function newProof(): { verifier: string; challenge: string } {
 const verifier = randomBytes(32).toString("base64url");
 return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
/** Проверяет формат verifier без его раскрытия клиентскому JavaScript. */
export function validVerifier(value: string | undefined): value is string { return !!value && tokenPattern.test(value); }
/** Формирует host-only cookie с ограниченным сроком жизни. */
export function proofCookie(value: string, maxAge: number): string { return `${stateCookie}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`; }
/** Извлекает единственное значение cookie, отклоняя неоднозначные заголовки. */
export function readProof(cookie: string | null): string | undefined {
 const values = (cookie ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${stateCookie}=`));
 return values.length === 1 ? values[0].slice(stateCookie.length + 1) : undefined;
}
