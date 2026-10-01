// ABOUTME: Собирает официальный MCP SDK с одним Streamable HTTP адресом.
// ABOUTME: HTTP-отмена закрывает SQL; Host и Origin проверяются до чтения тела.
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import { Database, ServiceError } from './database.js';
import { tools, type ToolName } from './contracts.js';
import { callTool } from './tools.js';
type Session = {
    transport: StreamableHTTPServerTransport;
    mcp: McpServer;
    touched: number;
    calls: Map<string, AbortController>;
};
/** Поднимает /mcp; close прекращает SQL и дожидается закрытия транспорта. */
export async function startServer(config: Config, database: Database): Promise<{
    http: Server;
    url: string;
    close: () => Promise<void>;
}> {
    const sessions = new Map<string, Session>();
    let stopping = false;
    let pending = 0;
    let port = config.port;
    const http = createServer(async (req, res) => {
        if (stopping) {
            res.writeHead(503).end();
            return;
        }
        if (req.url !== '/mcp') {
            res.writeHead(404).end();
            return;
        }
        const allowedHosts = config.allowedHosts ?? [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
        const allowedOrigins = config.allowedOrigins ?? allowedHosts.map(host => `http://${host}`);
        if (!req.headers.host || !allowedHosts.includes(req.headers.host) || (req.headers.origin && !allowedOrigins.includes(req.headers.origin))) {
            res.writeHead(403).end();
            return;
        }
        const sessionHeader = req.headers['mcp-session-id'];
        if (Array.isArray(sessionHeader)) {
            res.writeHead(400).end();
            return;
        }
        let session = sessionHeader ? sessions.get(sessionHeader) : undefined;
        if (sessionHeader && !session) {
            res.writeHead(404).end();
            return;
        }
        let ownsPending = false;
        if (!session) {
            if (req.method !== 'POST') {
                res.writeHead(400).end();
                return;
            }
            if (sessions.size + pending >= config.limits.sessions) {
                res.writeHead(503).end();
                return;
            }
            pending++;
            ownsPending = true;
        }
        const requestController = new AbortController();
        const disconnect = () => {
            if (!res.writableEnded)
                requestController.abort(new ServiceError('DISCONNECTED', undefined, 'unknown'));
        };
        res.once('close', disconnect);
        let requestKey: string | undefined;
        try {
            let body: unknown;
            if (req.method === 'POST') {
                const chunks: Buffer[] = [];
                let size = 0;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > 2000000) {
                        res.writeHead(413).end();
                        return;
                    }
                    chunks.push(Buffer.from(chunk));
                }
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (Array.isArray(body)) {
                    res.writeHead(400).end();
                    return;
                }
                if (body && typeof body === 'object' && 'id' in body)
                    requestKey = String(body.id);
            }
            if (!session) {
                const mcp = new McpServer({ name: 'brai-supabase-mcp', version: '0.1.0' });
                for (const name of Object.keys(tools) as ToolName[]) {
                    const definition = tools[name];
                    mcp.registerTool(name, {
                        description: definition.description,
                        inputSchema: definition.input,
                        outputSchema: definition.output,
                    }, async (args: unknown, extra: {
                        signal: AbortSignal;
                        requestId: string | number;
                    }) => {
                        const httpSignal = session?.calls.get(String(extra.requestId))?.signal;
                        const signal = httpSignal ? AbortSignal.any([extra.signal, httpSignal]) : extra.signal;
                        const value = await callTool(database, name, args, signal);
                        return { structuredContent: value, content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: value.ok === false };
                    });
                }
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    enableJsonResponse: true,
                    enableDnsRebindingProtection: true,
                    allowedHosts,
                    allowedOrigins,
                    onsessioninitialized: id => { sessions.set(id, session!); },
                });
                session = { transport, mcp, touched: Date.now(), calls: new Map() };
                transport.onclose = () => {
                    for (const controller of session!.calls.values())
                        controller.abort(new ServiceError('SESSION_CLOSED', undefined, 'unknown'));
                    if (transport.sessionId)
                        sessions.delete(transport.sessionId);
                };
                await mcp.connect(transport);
            }
            if (requestController.signal.aborted)
                return;
            if (requestKey !== undefined) {
                if (session.calls.has(requestKey)) {
                    res.writeHead(409).end();
                    return;
                }
                session.calls.set(requestKey, requestController);
            }
            session.touched = Date.now();
            await session.transport.handleRequest(req, res, body);
        }
        catch {
            if (!res.headersSent)
                res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"TRANSPORT_ERROR"}');
            else
                res.end();
        }
        finally {
            if (ownsPending)
                pending--;
            if (requestKey !== undefined)
                session?.calls.delete(requestKey);
            res.removeListener('close', disconnect);
            if (session && !session.transport.sessionId)
                await session.mcp.close().catch(() => { });
        }
    });
    const cleanup = setInterval(() => {
        for (const [id, session] of sessions) {
            if (session.calls.size === 0 && Date.now() - session.touched > config.limits.sessionIdleMs) {
                sessions.delete(id);
                void session.mcp.close().catch(() => { });
            }
        }
    }, Math.min(config.limits.sessionIdleMs, 30000));
    cleanup.unref();
    await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(config.port, config.host, () => { http.removeListener('error', reject); resolve(); });
    });
    const address = http.address();
    if (!address || typeof address === 'string')
        throw new Error('LISTEN_FAILED');
    port = address.port;
    return {
        http,
        url: `http://${config.host === '::1' ? '[::1]' : config.host}:${port}/mcp`,
        close: async () => {
            stopping = true;
            clearInterval(cleanup);
            await database.close();
            await Promise.all([...sessions.values()].map(session => session.mcp.close().catch(() => { })));
            sessions.clear();
            await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
        },
    };
}
