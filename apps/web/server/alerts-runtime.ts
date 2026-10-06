// ABOUTME: Подключает один Core NATS alerts subscriber на серверный процесс.
// ABOUTME: Разрыв брокера закрывает SSE; содержимое сигнала проверяется owner schema.
import type { NatsConnection } from "nats";
import { AlertsHub } from "./alerts-hub";
import { GatewayError, natsConnection } from "./gateway";
import { valid } from "./contracts";
import { alertsSchema } from "./alerts";
const key = Symbol.for("brai.web.alerts.runtime.v1");
type Runtime = { hub: AlertsHub; connect: () => Promise<void> };
const globals = globalThis as typeof globalThis & { [key]?: Runtime };
/** Сохраняет один subscriber и hub между вызовами маршрутов и hot reload. */
export function alertsRuntime(): Runtime {
 if (globals[key]) return globals[key];
 const hub = new AlertsHub();
 let watched: NatsConnection | undefined, active = false, connecting: Promise<void> | undefined;
 const statusWatched = new WeakSet<NatsConnection>();
 const connect = async () => {
  if (!connecting) connecting = (async () => {
   const nc = await natsConnection();
   if (nc.isClosed() || nc.isDraining()) throw new GatewayError(503, "UNAVAILABLE");
   if (watched === nc) { if (!active) throw new GatewayError(503, "UNAVAILABLE"); return; }
   const subscriber = nc.subscribe("brai.alerts.v1.changed");
   try { await nc.flush(); } catch (error) { subscriber.unsubscribe(); throw error; }
   watched = nc; active = true;
   if (!statusWatched.has(nc)) {
    statusWatched.add(nc);
    void (async () => { try { for await (const status of nc.status()) {
     if (watched !== nc) continue;
     // AIDEV-NOTE: Общий status error может принадлежать чужой подписке; alerts завершает свой iterator ниже.
     if (status.type === "disconnect") { active = false; hub.disconnect(); }
     if (status.type === "reconnect") { active = true; hub.disconnect(); }
    } } catch { /* Закрытие status iterator прекращает выдачу alerts в finally. */ }
    finally { if (watched === nc) { active = false; hub.disconnect(); } } })();
   }
   void (async () => { try { for await (const message of subscriber) {
    try {
     if (message.data.length > 2048) throw new Error("BAD_SIGNAL");
     const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(message.data));
     if (!valid(alertsSchema + "changed", value)) throw new Error("BAD_SIGNAL");
     hub.broadcast((value as { user_id: string | null }).user_id);
    } catch { hub.disconnect(); }
   } } catch { /* Ошибка собственной подписки закрывает SSE; следующий connect создаст её заново. */ }
   finally { if (watched === nc) { active = false; watched = undefined; hub.disconnect(); } } })();
  })().finally(() => { connecting = undefined; });
  await connecting;
 };
 return globals[key] = { hub, connect };
}
