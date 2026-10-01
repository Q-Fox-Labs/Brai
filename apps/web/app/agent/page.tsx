// ABOUTME: Предоставляет защищённую страницу агента через общий жизненный цикл аккаунта.
// ABOUTME: Вход, проверка сессии и выход принадлежат существующему Account.
import Account from "../account";

/** Показывает вход или страницу агента подтверждённого аккаунта. */
export default function AgentPage() {
  return <Account view="agent" />;
}
