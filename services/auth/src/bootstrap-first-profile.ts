// ABOUTME: Явный операторский вход для создания первого личного профиля.
// ABOUTME: Использует одну транзакцию Auth и штатную очередь подготовки профилей.
import { bootstrapOwner } from "./owner-bootstrap.js";

if (process.env.AUTH_IDENTITY_MODE !== "telegram") throw new Error("Telegram Auth mode required");
await bootstrapOwner(true);
