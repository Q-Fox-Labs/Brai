// ABOUTME: Явный операторский вход для создания первого личного профиля.
// ABOUTME: Использует одну транзакцию Auth и штатную очередь подготовки профилей.
process.env.AUTH_BOOTSTRAP_QUEUE_PROFILE = "true";
await import("./bootstrap.js");
