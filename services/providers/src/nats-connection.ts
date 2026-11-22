// ABOUTME: Подключает Providers к NATS с восстановлением после обрыва.
// ABOUTME: Не повторяет команды или запросы к модели.
import {connect,type ConnectionOptions,type NatsConnection} from 'nats';

/** Открывает соединение с проверенными параметрами runtime. */
export function connectBroker(options:ConnectionOptions):Promise<NatsConnection>{
  return connect({...options,maxReconnectAttempts:-1,maxPingOut:2,timeout:3000});
}
