// ABOUTME: Сохраняет общую оболочку и аккаунт при переходах между агентом и таймером.
// ABOUTME: Маршруты выбирают экран; состояние и подключения принадлежат Account.
import Account from "../account";
import Navigation from "../navigation";

/** Показывает постоянную верхнюю навигацию и экраны текущего аккаунта. */
export default function WorkspaceLayout() {
  return <div className="workspace-shell"><Navigation /><div className="workspace-content"><Account /></div></div>;
}
