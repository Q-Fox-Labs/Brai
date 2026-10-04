// ABOUTME: Восстанавливает исходный компонент TaskChildForm.tsx из Brai September.
// ABOUTME: Использует локальный TasksContext; серверные операции задач отсутствуют.
import { type FormEvent, useRef, useState } from "react";
import { useTasks } from "./TasksContext";
import type { Task } from "./types";

function childKindText(task: Task) {
  if (task.isMission) return { placeholder: "Новый квест", accusative: "квест" };
  if (task.isQuest) return { placeholder: "Новая цель", accusative: "цель" };
  return { placeholder: "Новая задача", accusative: "задачу" };
}

/** Сохраняет разметку и взаимодействия исходного компонента September на локальных данных. */
export default function TaskChildForm({ task }: { task: Task }) {
  const { addChildTask, highlightTask } = useTasks();
  const [title, setTitle] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const childKind = childKindText(task);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle || isAdding) return;

    setIsAdding(true);
    const createdTask = await addChildTask(task, nextTitle);
    setIsAdding(false);
    if (!createdTask) return;

    setTitle("");
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      highlightTask(createdTask.id, "right");
    });
  };

  return (
    <form className="border-b border-brai-line p-3" onSubmit={(event) => void submit(event)}>
      <input
        ref={inputRef}
        className="h-11 w-full rounded-lg border border-brai-line bg-brai-surface-subtle px-3 text-[13px] text-brai-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-brai-muted focus:border-brai-accent/65 focus:shadow-[0_0_0_3px_rgba(232,94,67,0.1)] disabled:opacity-65"
        type="text"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder={childKind.placeholder}
        aria-label={`Добавить ${childKind.accusative} в «${task.title}»`}
        maxLength={200}
        disabled={isAdding}
      />
    </form>
  );
}
