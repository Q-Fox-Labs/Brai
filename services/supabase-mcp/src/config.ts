// ABOUTME: Проверяет переносимую конфигурацию MCP и читает пароли из файлов.
// ABOUTME: Клиенты не задают адрес подключения или секрет PostgreSQL.
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
const instanceSchema = z.strictObject({
    id: z.string().min(1).max(100), host: z.string().min(1), port: z.number().int().min(1).max(65535),
    user: z.string().min(1), passwordFile: z.string().min(1).optional(),
    bootstrapDatabase: z.string().min(1).max(63),
    tls: z.union([z.literal(false), z.strictObject({ rejectUnauthorized: z.literal(true), caFile: z.string().optional() })]),
});
/** Единственная строгая схема серверной конфигурации; не содержит списка целевых БД. */
export const configSchema = z.strictObject({
    host: z.string().min(1).default('127.0.0.1'),
    allowedHosts: z.array(z.string().min(1)).min(1).optional(),
    allowedOrigins: z.array(z.string().min(1)).optional(), port: z.number().int().min(0).max(65535).default(3001),
    defaultInstance: z.string().min(1), instances: z.array(instanceSchema).min(1).max(100),
    limits: z.strictObject({
        connections: z.number().int().min(1).max(100).default(8), queue: z.number().int().min(0).max(1000).default(64),
        deadlineMs: z.number().int().min(100).max(600000).default(30000),
        rows: z.number().int().min(1).max(10000).default(1000), bytes: z.number().int().min(1024).max(10000000).default(1048576),
        sessions: z.number().int().min(1).max(1000).default(100), sessionIdleMs: z.number().int().min(1000).max(3600000).default(300000),
    }).prefault({}),
}).superRefine((value, context) => {
    const ids = value.instances.map(x => x.id);
    if (!['127.0.0.1', '::1', 'localhost'].includes(value.host) && !value.allowedHosts)
        context.addIssue({ code: 'custom', message: 'Explicit allowedHosts required for non-loopback bind' });
    if (new Set(ids).size !== ids.length || !ids.includes(value.defaultInstance))
        context.addIssue({ code: 'custom', message: 'Invalid instance identifiers' });
});
export type Config = z.infer<typeof configSchema>;
export type Instance = Config['instances'][number] & {
    password?: string;
    ssl: false | {
        rejectUnauthorized: true;
        ca?: string;
    };
};
/** Проверяет конфигурацию без обращения к БД; неверные поля вызывают исключение. */
export function parseConfig(value: unknown): Config { return configSchema.parse(value); }
/** Загружает серверные секреты; возвращаемые экземпляры нельзя выдавать клиенту или журналировать. */
export async function loadInstances(config: Config): Promise<Instance[]> {
    return Promise.all(config.instances.map(async (instance) => ({ ...instance,
        password: instance.passwordFile ? (await readFile(instance.passwordFile, 'utf8')).replace(/\r?\n$/, '') : undefined,
        ssl: instance.tls === false ? false : { rejectUnauthorized: true as const, ca: instance.tls.caFile ? await readFile(instance.tls.caFile, 'utf8') : undefined },
    })));
}
