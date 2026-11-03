// ABOUTME: Проверяет входы транспорта и направляет запросы в ядро целей.
// ABOUTME: Владелец и актор передаются доверенным адаптером отдельно от аргументов.
import { readFileSync } from "node:fs";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { GoalsFault, type createDomain } from "./domain.js";

/** Правила использования сервиса для агентного клиента. */
export const agentInstructions = "Факты пользователя обновляют сведения; желания сохраняй как обсуждаемые цели, варианты обозначай предложениями. Выбирай главный фокус и отмечай достижение только по явным словам пользователя. Для каждой записи сохраняй источник сообщения и его дату. При неизвестном результате сначала прочитай текущее состояние и историю; не повторяй изменение вслепую.";

type Args = Record<string, unknown>;
const requestSchema = JSON.parse(readFileSync(new URL("../schemas/messages.schema.json",import.meta.url),"utf8"));
const validateRequest = new AjvJsonSchemaValidator().getValidator(requestSchema);
const entities = ["goals", "focus", "entries", "resources", "needs", "allocations"] as const;
const names: Record<string, string> = {
  goals_goal_put: "goals", goals_focus_put: "focus", goals_entry_put: "entries",
  goals_resource_put: "resources", goals_need_put: "needs", goals_allocation_put: "allocations",
};
function argsObject(value: unknown): Args {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GoalsFault("INVALID_ARGUMENT");
  return value as Args;
}
function only(value: Args, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new GoalsFault("INVALID_ARGUMENT");
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new GoalsFault("INVALID_ARGUMENT");
  return value;
}
function version(value: unknown): string | null {
  if (value === null) return null;
  return string(value);
}

/** Обрабатывает одну операцию; контекст владельца не принимается из payload. */
export async function invoke(domain: ReturnType<typeof createDomain>, owner: string, actor: string, operation: string, input: unknown): Promise<unknown> {
  if (!validateRequest({user_id:owner,operation,input}).valid) throw new GoalsFault("INVALID_ARGUMENT");
  const value = argsObject(input);
  if (operation === "goals_overview") {
    only(value, []);
    return domain.overview(owner);
  }
  if (operation === "goals_list") {
    only(value, ["entity"]);
    return { items: await domain.list(owner, string(value.entity)) };
  }
  if (operation === "goals_get") {
    only(value, ["entity", "id"]);
    const items = await domain.list(owner, string(value.entity));
    const item = items.find(row => row.id === string(value.id));
    if (!item) throw new GoalsFault("NOT_FOUND");
    return { item };
  }
  if (operation === "goals_history") {
    only(value, ["entity", "id"]);
    return { items: await domain.history(owner, string(value.entity), string(value.id)) };
  }
  if (operation === "goals_delete") {
    only(value, ["entity", "id", "request_id", "expected_version", "source"]);
    const entityName = string(value.entity);
    if (entityName === "focus") throw new GoalsFault("INVALID_ARGUMENT");
    const data = entityName === "allocations" ? {deleted:true,active:false} : {deleted:true};
    return {item:await domain.change(owner,actor,string(value.source),string(value.request_id),entityName,string(value.id),string(value.expected_version),data,"delete")};
  }
  if (operation === "goals_restore") {
    only(value, ["entity", "id", "request_id", "expected_version", "target_version", "source"]);
    return { item: await domain.restore(owner, actor, string(value.source), string(value.request_id), string(value.entity), string(value.id), string(value.expected_version), string(value.target_version)) };
  }
  const entity = names[operation];
  if (!entity) throw new GoalsFault("INVALID_ARGUMENT");
  only(value, ["id", "request_id", "expected_version", "source", "data"]);
  return { item: await domain.change(owner, actor, string(value.source), string(value.request_id), entity, string(value.id), version(value.expected_version), argsObject(value.data)) };
}

export const operations = ["goals_overview", "goals_list", "goals_get", "goals_history", "goals_restore", "goals_delete", ...Object.keys(names)] as const;
