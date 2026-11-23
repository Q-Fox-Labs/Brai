// ABOUTME: Проверяет готовность Providers с повторной сверкой изменчивых зависимостей.
// ABOUTME: Во время проверки не вызывает модель и не начинает пользовательские операции.
export function readiness(dependencies: {
  connected: () => boolean;
  servicesReady: () => boolean;
  storage: () => Promise<unknown>;
  proxy: () => Promise<boolean>;
}): () => Promise<boolean> {
  return async () => {
    if (!dependencies.connected() || !dependencies.servicesReady()) return false;
    try {
      const [, proxyReady] = await Promise.all([dependencies.storage(), dependencies.proxy()]);
      return proxyReady && dependencies.connected() && dependencies.servicesReady();
    } catch {
      return false;
    }
  };
}
