"use client";
// ABOUTME: Владеет одним клиентом alerts для всей оболочки текущего аккаунта.
// ABOUTME: Remount аккаунта удаляет старые подписки, запросы и сохранённую ленту.
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { AlertsClient } from "@/lib/alerts-client";
const Context = createContext<AlertsClient | null>(null);
/** Запускает alerts только после подтверждённого входа; key аккаунта задаёт владелец оболочки. */
export function AlertsProvider({ userId, onUnauthorized, children }: { userId: string; onUnauthorized: () => void; children: ReactNode }) {
 const [client] = useState(() => new AlertsClient({ userId, fetch: (...args) => fetch(...args), events: () => new EventSource("/api/alerts/events?expectedUserId=" + encodeURIComponent(userId)), onUnauthorized }));
 useEffect(() => { client.start(); return () => client.stop(); }, [client]);
 return <Context.Provider value={client}>{children}</Context.Provider>;
}
/** Возвращает согласованный снимок единого клиента уведомлений аккаунта. */
export function useAlerts() {
 const client = useContext(Context);
 if (!client) throw new Error("ALERTS_PROVIDER_REQUIRED");
 const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
 return { client, ...state };
}
