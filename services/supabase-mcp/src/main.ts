// ABOUTME: Запускает независимый MCP по явно заданному JSON-файлу.
// ABOUTME: Ошибки запуска не раскрывают содержимое конфигурации и секретов.
import { readFile } from 'node:fs/promises';
import { parseConfig, loadInstances } from './config.js';
import { Database } from './database.js';
import { startServer } from './server.js';
const path = process.argv[2] ?? process.env.SUPABASE_MCP_CONFIG;
try {
    if (!path)
        throw new Error('CONFIG_REQUIRED');
    const config = parseConfig(JSON.parse(await readFile(path, 'utf8')));
    const database = new Database(config, await loadInstances(config));
    const server = await startServer(config, database);
    console.log(JSON.stringify({ event: 'listening', url: server.url }));
    let closing = false;
    const stop = () => {
        if (closing)
            return;
        closing = true;
        void server.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}
catch {
    console.error('{"event":"startup_failed"}');
    process.exitCode = 1;
}
