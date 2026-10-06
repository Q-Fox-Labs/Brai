// ABOUTME: Сохраняет общую оболочку и аккаунт при переходах между рабочими разделами.
// ABOUTME: Маршруты выбирают экран; состояние и подключения принадлежат Account.
import Account from "../account";

/** Показывает постоянную оболочку навигации и экраны текущего аккаунта. */
export default function WorkspaceLayout() {
  return <Account />;
}
