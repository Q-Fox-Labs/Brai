// ABOUTME: Проверяет готовность действующего Providers через его закрытый HTTP вход.
// ABOUTME: Не вызывает модель и не выводит credentials или ответ службы.
const port = Number(process.env.PROVIDERS_HTTP_PORT);
const token = process.env.PROVIDERS_HTTP_TOKEN;
if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) process.exit(1);
try {
  const response = await fetch(`http://127.0.0.1:${port}/internal/readiness`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
  });
  const result: unknown = await response.json();
  if (!response.ok || !result || typeof result !== 'object' || !('ready' in result) || result.ready !== true) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
