// ABOUTME: Применяет повторяемую миграцию только собственной БД providers.
// ABOUTME: Вызывается явно при выпуске, URI и SQL payload не выводятся.
import { postgresStore } from "./postgres.js";
if(!process.env.PROVIDERS_DATABASE_URL)throw new Error("MISSING_DATABASE_CONFIGURATION");
const store=postgresStore(process.env.PROVIDERS_DATABASE_URL);
try {await store.migrate();}finally{await store.close();}
