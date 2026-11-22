// ABOUTME: Выполняет прежнюю операторскую подготовку владельца Auth.
// ABOUTME: Вызов не ставит подготовку нового профиля в очередь.
import { bootstrapOwner } from "./owner-bootstrap.js";

await bootstrapOwner(false);
