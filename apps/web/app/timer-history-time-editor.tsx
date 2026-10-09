"use client";
// ABOUTME: Переносит компактный TimeEditor из Brai-old без изменения оформления.
// ABOUTME: Принимает значения и callbacks; правила времени принадлежат модели Brai.
import { Check, Minus, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/components/ui/cn";
import { normalizeEditValue, type EditField } from "./timer-history-model";

/** Редактирует одно поле времени через ввод или шаг, сохраняя разметку Brai-old. */
export function TimeEditor({
  changed,
  editing,
  featured = false,
  field,
  inputValue,
  label,
  value,
  onBeginInput,
  onCancelInput,
  onCommitInput,
  onInput,
  onStep,
}: {
  changed: boolean;
  editing: boolean;
  featured?: boolean;
  field: EditField;
  inputValue: string;
  label: string;
  value: string;
  onBeginInput: (field: EditField) => void;
  onCancelInput: () => void;
  onCommitInput: () => void;
  onInput: (value: string) => void;
  onStep: (direction: -1 | 1) => void;
}) {
  const invalid = editing && normalizeEditValue(field, inputValue) == null;
  const changedClass = changed && "border-amber-500/70 bg-amber-500/10 text-amber-600 dark:border-amber-300/70 dark:bg-amber-300/10 dark:text-amber-300";
  return (
    <div
      className={cn(
        "grid h-11 min-w-0 grid-rows-[0.875rem_1fr] rounded-md border bg-background/45 px-1 py-0.5 transition-colors",
        featured && !changed && "border-primary/35 bg-primary/10",
        changedClass,
        editing && "border-ring bg-accent/40",
      )}
    >
      <span className={cn("truncate text-center text-xs leading-3", changed ? "text-amber-600 dark:text-amber-300" : "text-muted-foreground")}>{label}</span>
      <div className="grid min-w-0 grid-cols-[1.125rem_minmax(2.5rem,1fr)_1.125rem] items-center gap-0.5">
        <Button
          aria-label={editing ? "Отменить ввод времени" : "Уменьшить на 5 минут"}
          className="size-5 rounded-sm"
          onClick={(event) => {
            event.stopPropagation();
            if (editing) {
              onCancelInput();
            } else {
              onStep(-1);
            }
          }}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          {editing ? <X className="size-3" aria-hidden="true" /> : <Minus className="size-3" aria-hidden="true" />}
        </Button>
        {editing ? (
          <Input
            aria-invalid={invalid}
            aria-label="Значение времени"
            className="h-6 min-w-0 rounded-sm px-0.5 text-center text-sm text-amber-600 tabular-nums dark:text-amber-300"
            autoFocus
            inputMode="text"
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => onInput(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); onCommitInput(); }
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancelInput(); }
            }}
            value={inputValue}
          />
        ) : (
          <button
            className={cn(
              "h-6 min-w-0 whitespace-nowrap rounded-sm px-0 text-center text-sm font-semibold tabular-nums transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              changed ? "text-amber-600 dark:text-amber-300" : featured ? "text-primary" : "text-foreground",
            )}
            onClick={(event) => {
              event.stopPropagation();
              onBeginInput(field);
            }}
            type="button"
          >
            {value}
          </button>
        )}
        <Button
          aria-label={editing ? "Применить ввод времени" : "Увеличить на 5 минут"}
          className="size-5 rounded-sm"
          disabled={invalid}
          onClick={(event) => {
            event.stopPropagation();
            if (editing) {
              onCommitInput();
            } else {
              onStep(1);
            }
          }}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          {editing ? <Check className="size-3" aria-hidden="true" /> : <Plus className="size-3" aria-hidden="true" />}
        </Button>
      </div>
    </div>
  );
}

