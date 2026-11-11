// ABOUTME: Открывает фиксированный серверный endpoint реестра bug-hunt.
// ABOUTME: Имя операции проверяет адаптер; произвольные NATS subjects недоступны.
import {bugHuntRequest} from "@/server/bug-hunt";
export const runtime="nodejs";
/** Передаёт ограниченный запрос проверяющему сессию адаптеру. */
export const POST=bugHuntRequest;
