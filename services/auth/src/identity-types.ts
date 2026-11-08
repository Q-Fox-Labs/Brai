// ABOUTME: Определяет данные идентичности и запросы закрытой границы Auth v2.
// ABOUTME: Сам по себе тип не предоставляет endpoint и не подтверждает доступ.

export type Role = "admin" | "user";
export type Status = "provisioning" | "active" | "blocked";
export interface IdentityUser {
 id:string; name:string; role:Role; status:Status;
 telegramId:string|null; profileId:string|null; telegramIds?:string[]; email?:string;
}
export interface HeadersInput {
 cookie?:string; origin?:string; "user-agent"?:string;
 "x-forwarded-for"?:string; "sec-fetch-site"?:string;
}
export interface WebRequest<T> { headers:HeadersInput; body:T; }
export interface WebResponse<T> { status:number; body:T; setCookies:string[]; }
export interface TelegramResolveRequest { telegramId:string; }
export interface TelegramCodeIssueRequest { telegramId:string; requestId:string; }
export interface TelegramCodeIssueResponse { code:string; expiresAt:string; origin:string; }
export interface ProvisionRequest {
 requestId:string; telegramId:string; name?:string; role:Role;
 userId?:string; profileId?:string; status:Status;
}
export interface Invite { id:string; expiresAt:string; createdAt:string; revokedAt:string|null; consumedAt:string|null; }
export interface InviteCreated extends Invite { code:string; }
