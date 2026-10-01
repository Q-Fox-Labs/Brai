// ABOUTME: Проверяет deadline и отмену до завершения PostgreSQL handshake.
// ABOUTME: Использует собственный loopback TCP-стенд без рабочей БД и секретов.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as tcpServer } from 'node:net';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseConfig, loadInstances } from '../dist/config.js';
import { Database } from '../dist/database.js';
import { startServer } from '../dist/server.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test('stalled PostgreSQL handshake obeys deadline and early cancellation releases its sole lease', async () => {
    const sockets = new Set();
    const stalled = tcpServer({ allowHalfOpen: true }, socket => { sockets.add(socket); socket.on('data', () => { }); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve));
    const port = stalled.address().port;
    const limited = parseConfig({ port: 0, defaultInstance: 'stalled', instances: [{ id: 'stalled', host: '127.0.0.1', port, user: 'postgres', bootstrapDatabase: 'postgres', tls: false }], limits: { connections: 1, queue: 1, deadlineMs: 350 } });
    const stalledDb = new Database(limited, await loadInstances(limited));
    const endpoint = await startServer(limited, stalledDb);
    const probe = new McpClient({ name: 'stalled-handshake', version: '1' });
    const wire = new StreamableHTTPClientTransport(new URL(endpoint.url));
    try {
        await probe.connect(wire);
        const started = performance.now();
        const result = await probe.callTool({ name: 'list_databases', arguments: {} });
        assert.equal(result.structuredContent.error.code, 'DEADLINE_EXCEEDED');
        assert.ok(performance.now() - started < 800);
        assert.equal(stalledDb.usage()[0].active, 0);
        const controller = new AbortController();
        const pending = probe.callTool({ name: 'list_databases', arguments: {} }, undefined, { signal: controller.signal });
        await sleep(50);
        controller.abort();
        await assert.rejects(pending);
        const cancelledAt = performance.now();
        while (stalledDb.usage()[0].active && performance.now() - cancelledAt < 150)
            await sleep(5);
        assert.equal(stalledDb.usage()[0].active, 0);
        assert.equal(stalledDb.usage()[0].queued, 0);
    }
    finally {
        await wire.terminateSession().catch(() => { });
        await probe.close();
        await endpoint.close();
        for (const socket of sockets)
            socket.destroy();
        await new Promise(resolve => stalled.close(resolve));
    }
});
