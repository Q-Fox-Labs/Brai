// ABOUTME: Изолирует SQL-вызовы и ограничивает все соединения одного экземпляра.
// ABOUTME: Отмена закрывает соединение без повторного выполнения SQL.
import { Socket } from 'node:net';
import pg, { type Client, type QueryResult, type QueryArrayConfig } from 'pg';
import type { Config, Instance } from './config.js';
/** Ошибка границы без текста PostgreSQL, параметров подключения и пользовательского SQL. */
export class ServiceError extends Error {
    constructor(public readonly code: string, public readonly sqlstate?: string, public readonly outcome: 'not_started' | 'unknown' = 'not_started') { super(code); }
}
/** Переводит внутреннюю ошибку в безопасный машинный ответ. */
export function safeError(error: unknown): {
    code: string;
    sqlstate?: string;
    outcome: 'not_started' | 'unknown';
} {
    if (error instanceof ServiceError)
        return { code: error.code, ...(error.sqlstate ? { sqlstate: error.sqlstate } : {}), outcome: error.outcome };
    const sqlstate = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : undefined;
    return { code: 'DATABASE_ERROR', ...(sqlstate ? { sqlstate } : {}), outcome: 'unknown' };
}
type Waiter = {
    resolve: () => void;
    reject: (e: Error) => void;
    signal: AbortSignal;
    abort: () => void;
};
class Budget {
    active = 0;
    waiters: Waiter[] = [];
    constructor(readonly limit: number, readonly queue: number) { }
    async acquire(signal: AbortSignal): Promise<() => void> {
        if (signal.aborted)
            throw signal.reason;
        if (this.active < this.limit)
            this.active++;
        else {
            if (this.waiters.length >= this.queue)
                throw new ServiceError('BUSY');
            await new Promise<void>((resolve, reject) => {
                const waiter: Waiter = { resolve, reject, signal, abort: () => { this.waiters = this.waiters.filter(x => x !== waiter); reject(signal.reason); } };
                signal.addEventListener('abort', waiter.abort, { once: true });
                this.waiters.push(waiter);
            });
        }
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            const next = this.waiters.shift();
            if (next) {
                next.signal.removeEventListener('abort', next.abort);
                next.resolve();
            }
            else
                this.active--;
        };
    }
}
export type StatementResult = {
    statementIndex: number;
    command: string | null;
    columns: {
        name: string;
        dataTypeID: number;
    }[];
    rows: unknown[][];
    rowCount: number | null;
    truncated: boolean;
};
function jsonValue(value: unknown): unknown {
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime()))
            throw new ServiceError('SERIALIZATION_ERROR', undefined, 'unknown');
        return value.toISOString();
    }
    if (typeof value === 'number' && !Number.isFinite(value))
        return String(value);
    if (Buffer.isBuffer(value))
        return value.toString('base64');
    if (typeof value === 'bigint')
        return value.toString();
    if (Array.isArray(value))
        return value.map(jsonValue);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
    return value;
}
/** Выполняет исходный SQL один раз, собирая ограниченный результат каждого statement по событиям строк. */
export function streamQuery(client: Client, sql: string, limits: {
    rows: number;
    bytes: number;
}, values?: unknown[]): Promise<{
    results: StatementResult[];
    omittedResults: number;
}> {
    return new Promise((resolve, reject) => {
        const query = new pg.Query({ text: sql, values, rowMode: 'array' } as QueryArrayConfig);
        const collected = new Map<QueryResult, {
            rows: unknown[][];
            truncated: boolean;
        }>();
        let rowBudget = limits.rows, byteBudget = limits.bytes;
        query.on('row', (raw: unknown[], result: QueryResult | undefined) => {
            if (!result)
                return;
            let item = collected.get(result);
            if (!item) {
                item = { rows: [], truncated: false };
                collected.set(result, item);
            }
            if (rowBudget <= 0 || byteBudget <= 0) {
                item.truncated = true;
                return;
            }
            let row: unknown[], size: number;
            try {
                row = raw.map(jsonValue);
                size = Buffer.byteLength(JSON.stringify(row));
            }
            catch {
                reject(new ServiceError('SERIALIZATION_ERROR', undefined, 'unknown'));
                return;
            }
            if (size > byteBudget) {
                item.truncated = true;
                byteBudget = 0;
                return;
            }
            item.rows.push(row);
            rowBudget--;
            byteBudget -= size;
        });
        query.once('error', reject);
        query.once('end', (received: QueryResult | QueryResult[]) => {
            const results: StatementResult[] = [];
            let remaining = limits.bytes - 512, omittedResults = 0;
            for (const [statementIndex, result] of (Array.isArray(received) ? received : [received]).entries()) {
                const statement: StatementResult = { statementIndex, command: result.command, columns: result.fields.map(field => ({ name: field.name, dataTypeID: field.dataTypeID })),
                    rows: collected.get(result)?.rows ?? [], rowCount: result.rowCount, truncated: collected.get(result)?.truncated ?? false };
                let size = Buffer.byteLength(JSON.stringify(statement)) + 1;
                while (size > remaining && statement.rows.length) {
                    const removed = statement.rows.pop()!;
                    size -= Buffer.byteLength(JSON.stringify(removed)) + (statement.rows.length ? 1 : 0);
                    if (!statement.truncated)
                        size -= 1;
                    statement.truncated = true;
                }
                if (size > remaining) {
                    omittedResults++;
                    continue;
                }
                results.push(statement);
                remaining -= size;
            }
            resolve({ results, omittedResults });
        });
        client.query(query);
    });
}
/** Владеет бюджетами и активными соединениями; каждое обращение читает актуальный каталог. */
export class Database {
    private budgets: Map<string, Budget>;
    private drainWaiters = new Set<() => void>();
    private controllers = new Set<AbortController>();
    private stopping = false;
    constructor(readonly config: Config, private readonly instances: Instance[]) {
        this.budgets = new Map(instances.map(x => [x.id, new Budget(config.limits.connections, config.limits.queue)]));
    }
    /** Возвращает только публичные идентификаторы; пароль и адрес подключения остаются на сервере. */
    listInstances() { return this.instances.map(x => ({ id: x.id, isDefault: x.id === this.config.defaultInstance })); }
    /** Показывает общий текущий бюджет для диагностики и проверок; не раскрывает подключения. */
    usage() { return [...this.budgets].map(([instance, x]) => ({ instance, active: x.active, queued: x.waiters.length })); }
    /** Выполняет один изолированный вызов с общим deadline, включая очередь, каталог и target. */
    async use<T>(instanceId: string | undefined, database: string | undefined, caller: AbortSignal, action: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> {
        if (this.stopping)
            throw new ServiceError('SHUTTING_DOWN');
        const instance = this.instances.find(x => x.id === (instanceId ?? this.config.defaultInstance));
        if (!instance)
            throw new ServiceError('INSTANCE_NOT_FOUND');
        const controller = new AbortController();
        this.controllers.add(controller);
        const timer = setTimeout(() => controller.abort(new ServiceError('DEADLINE_EXCEEDED', undefined, 'unknown')), this.config.limits.deadlineMs);
        const cancel = () => controller.abort(new ServiceError('CANCELLED', undefined, 'unknown'));
        caller.addEventListener('abort', cancel, { once: true });
        if (caller.aborted)
            cancel();
        let release: (() => void) | undefined;
        let current: Client | undefined;
        let socket: Socket | undefined;
        // AIDEV-NOTE: Client.end() до конца connect подавляет pg connect callback; здесь закрываем только свой socket.
        const close = () => { socket?.destroy(); };
        controller.signal.addEventListener('abort', close);
        const connect = async (name: string) => {
            if (controller.signal.aborted)
                throw controller.signal.reason;
            socket = new Socket();
            current = new pg.Client({ stream: () => socket, host: instance.host, port: instance.port, user: instance.user, password: instance.password, database: name, ssl: instance.ssl,
                application_name: 'brai-supabase-mcp', connectionTimeoutMillis: this.config.limits.deadlineMs });
            current.on('error', () => { });
            await current.connect();
            if (controller.signal.aborted)
                throw controller.signal.reason;
            return current;
        };
        const disconnect = async () => {
            if (current) {
                const closing = current;
                const closingSocket = socket;
                current = undefined;
                socket = undefined;
                const ended = closing.end().catch(() => { });
                closingSocket?.destroy();
                await ended;
            }
        };
        try {
            release = await this.budgets.get(instance.id)!.acquire(controller.signal);
            let client = await connect(instance.bootstrapDatabase);
            if (database !== undefined) {
                const target = await client.query('SELECT datallowconn FROM pg_catalog.pg_database WHERE datname=$1', [database]);
                if (!target.rowCount)
                    throw new ServiceError('DATABASE_NOT_FOUND');
                if (!target.rows[0].datallowconn)
                    throw new ServiceError('DATABASE_CONNECTION_DISABLED');
                await disconnect();
                client = await connect(database);
            }
            return await action(client, controller.signal);
        }
        catch (error) {
            if (controller.signal.aborted)
                throw controller.signal.reason;
            throw error;
        }
        finally {
            clearTimeout(timer);
            caller.removeEventListener('abort', cancel);
            controller.signal.removeEventListener('abort', close);
            await disconnect();
            release?.();
            this.controllers.delete(controller);
            if (this.controllers.size === 0) {
                for (const resolve of this.drainWaiters)
                    resolve();
                this.drainWaiters.clear();
            }
        }
    }
    /** Прекращает приём SQL и закрывает все текущие соединения; очередь получает отмену. */
    async close() {
        this.stopping = true;
        for (const controller of this.controllers)
            controller.abort(new ServiceError('SHUTTING_DOWN', undefined, 'unknown'));
        if (this.controllers.size)
            await new Promise<void>(resolve => this.drainWaiters.add(resolve));
    }
}
