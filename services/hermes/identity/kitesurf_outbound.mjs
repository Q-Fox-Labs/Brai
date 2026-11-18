// ABOUTME: Передаёт сетевые запросы Kitesurf в предоставленный локальный прокси.
// ABOUTME: Сетевую изоляцию, доверенный proxy dispatcher и запуск обеспечивает вызывающий.

/**
 * Создать транспорт для Miniflare outboundService без прямого сетевого fallback.
 * proxyFetch и dispatcher предоставляет доверенный запуск. Redirect обрабатывает
 * Kitesurf; это позволяет шлюзу отдельно проверять каждое назначение.
 * WebSocket пока не поддерживается и завершается ошибкой.
 */
export function kitesurfOutbound(proxyFetch, dispatcher) {
  if (typeof proxyFetch !== 'function' || !dispatcher || typeof dispatcher.dispatch !== 'function') {
    throw new TypeError('A trusted proxy dispatcher is required');
  }
  return async request => {
    const url = new URL(request.url);
    if (!['http:', 'https:'].includes(url.protocol) || request.headers.has('upgrade')) {
      throw new TypeError('Unsupported browser network request');
    }
    const options = {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      redirect: 'manual',
      dispatcher,
    };
    if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
      options.body = request.body;
      options.duplex = 'half';
    }
    return proxyFetch(request.url, options);
  };
}
