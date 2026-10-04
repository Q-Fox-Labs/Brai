// ABOUTME: Создаёт синтетические проекты и четырёхуровневое дерево для раздела «Дела».
// ABOUTME: Данные вымышлены; новая сессия экрана всегда начинает с этого набора.
import { syncTaskStatuses, type Project, type Task, type TaskKind, type TaskStatus } from "./model.ts";

export const demoProjects: Project[] = [
  { id: "brai", title: "Brai", color: "#bb8aff" },
  { id: "personal", title: "Личное", color: "#6acbc0" },
  { id: "learning", title: "Обучение", color: "#ff9966" },
];

/** Возвращает независимый набор записей для нового экземпляра экрана. */
export function createDemoTasks(): Task[] {
  const tasks: Task[] = [];
  const add = (id: string, title: string, kind: TaskKind, parentId: string | null, projectId: string | null, description: string | null = null, status: TaskStatus = "active", blockerIds: string[] = []) => {
    const index = tasks.length;
    tasks.push({ id, title, blockers: [], relativeNumber: null, publicId: String(101 + index), parentId, projectId, description, result: status === "completed" ? "Готово: результат проверен и принят." : null, status, isMission: kind === "mission", isQuest: kind === "quest", isGoal: kind === "goal", blockerIds, sortOrder: tasks.filter(task => task.parentId === parentId).length, createdAt: Date.UTC(2026, 9, 1, 10, index * 7) });
  };
  add("m-brai", "Сделать Brai удобным каждый день", "mission", null, "brai", "Собрать спокойное рабочее пространство для дел, фокуса и идей.");
  add("q-workspace", "Рабочее пространство", "quest", "m-brai", "brai", "Все повседневные инструменты — в одном месте.");
  add("g-interface", "Подготовить интерфейс дел", "goal", "q-workspace", "brai", "Проверить дерево задач, цветные статусы и удобство перемещения.\nИнтерфейс должен хорошо работать на широком и узком экране.");
  add("t-reference", "Собрать примеры экранов", "task", "g-interface", "brai", null, "completed");
  add("t-colors", "Выбрать цвета для миссий, квестов и целей", "task", "g-interface", "brai", null, "completed");
  add("t-tree", "Разложить задачи по уровням", "task", "g-interface", "brai", "Миссия содержит квесты, квест — цели, цель — задачи.");
  add("t-drag", "Проверить перенос между целями", "task", "g-interface", "brai", "Перетащите запись за свободную область строки. У края списка включается прокрутка.");
  add("t-mobile", "Подготовить мобильный экран", "task", "g-interface", "brai", null, "active", ["t-tree"]);
  add("g-focus", "Настроить рабочий ритм", "goal", "q-workspace", "brai", "Небольшие привычки помогают сохранять внимание.");
  add("t-focus-1", "Выделить время для спокойной работы", "task", "g-focus", "brai", null, "completed");
  add("t-focus-2", "Составить список отвлекающих факторов", "task", "g-focus", "brai");
  add("t-focus-3", "Попробовать два коротких блока фокуса", "task", "g-focus", "brai");
  add("t-focus-4", "Подвести итоги недели", "task", "g-focus", "brai");
  add("q-feedback", "Обратная связь", "quest", "m-brai", "brai");
  add("g-feedback", "Собрать первые впечатления", "goal", "q-feedback", "brai");
  ["Подготовить сценарий знакомства", "Составить вопросы о задачнике", "Записать наблюдения", "Выделить три главных улучшения"].forEach((title, index) => add(`t-feedback-${index}`, title, "task", "g-feedback", "brai"));
  add("m-personal", "Освободить время для важного", "mission", null, "personal", "Навести порядок в повседневных делах и оставить место для отдыха.");
  add("q-home", "Дом и повседневные дела", "quest", "m-personal", "personal");
  add("g-home", "Организовать рабочее место", "goal", "q-home", "personal");
  ["Разобрать заметки на столе", "Настроить освещение", "Убрать лишние провода", "Выделить место для блокнота", "Проверить удобство кресла"].forEach((title, index) => add(`t-home-${index}`, title, "task", "g-home", "personal", null, index < 2 ? "completed" : "active"));
  add("g-week", "Спланировать выходные", "goal", "q-home", "personal");
  ["Выбрать маршрут для прогулки", "Забронировать время без встреч", "Составить список покупок"].forEach((title, index) => add(`t-week-${index}`, title, "task", "g-week", "personal"));
  add("q-health", "Энергия и отдых", "quest", "m-personal", "personal");
  add("g-health", "Восстановить режим", "goal", "q-health", "personal");
  ["Прогуляться после обеда", "Лечь спать в одно время", "Подготовить завтрак заранее", "Сделать перерыв без телефона"].forEach((title, index) => add(`t-health-${index}`, title, "task", "g-health", "personal"));
  add("g-learning", "Пройти небольшой курс", "goal", null, "learning", "Практика небольшими шагами.");
  ["Выбрать тему курса", "Прочитать первый раздел", "Решить упражнения", "Сделать короткий конспект", "Повторить сложные примеры", "Собрать итоговый проект"].forEach((title, index) => add(`t-learning-${index}`, title, "task", "g-learning", "learning", null, index < 2 ? "completed" : index === 4 ? "not_completed" : "active"));
  add("t-inbox-1", "Записать идею для следующей недели", "task", null, null);
  add("t-inbox-2", "Разобрать сохранённые ссылки", "task", null, null);
  return syncTaskStatuses(tasks);
}
