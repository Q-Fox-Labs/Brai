// ABOUTME: Показывает только модели и уровни рассуждения объявленного native каталога.
// ABOUTME: Передаёт выбор экрану; не запускает задания и не расширяет список значений.
import type { ModelChoice, PermissionMode } from "@brai/agent/contracts";
const labels: Record<string, string> = { low: "Низкое", medium: "Среднее", high: "Высокое", xhigh: "Очень высокое", max: "Максимальное", ultra: "Ультра" };
/** Настройки нового задания; активный steer сохраняет модель уже исполняемого хода. */
export default function ModelSettings({ models, model, effort, permissionMode, disabled, chooseModel, chooseEffort, choosePermissions }: { models: ModelChoice[]; model: string; effort: string; permissionMode: PermissionMode; choosePermissions: (value: PermissionMode) => void; disabled: boolean; chooseModel: (value: string) => void; chooseEffort: (value: string) => void }) {
  const selected = models.find(value => value.model === model);
  return <div className="agent-model-settings">
    <label>Модель <select aria-label="Модель" disabled={disabled || !models.length} value={model} onChange={event => chooseModel(event.target.value)}>{!models.length && <option value="">Загрузка моделей…</option>}{models.map(value => <option key={value.model} value={value.model}>{value.name}</option>)}</select></label>
    <label>Рассуждение <select aria-label="Рассуждение" disabled={disabled || !selected} value={effort} onChange={event => chooseEffort(event.target.value)}>{selected?.efforts.map(value => <option key={value} value={value}>{labels[value] ?? value}</option>)}</select></label>
    <label>Разрешения <select aria-label="Разрешения" disabled={disabled} value={permissionMode} onChange={event => choosePermissions(event.target.value as PermissionMode)}><option value="ask">Запрашивать разрешение</option><option value="auto">Подтверждать за меня</option><option value="full">Полный доступ</option></select></label>
  </div>;
}
