// ABOUTME: Проверяет wire-данные по JSON Schema сервиса таймера.
// ABOUTME: Загружает публичный контракт владельца, не импортирует внутренний код сервиса.
import Ajv from "ajv";
import addFormats from "ajv-formats";
import common from "../../../services/timer/schemas/common.schema.json";
import commands from "../../../services/timer/schemas/commands.schema.json";
import messages from "../../../services/timer/schemas/messages.schema.json";
import auth from "../../../services/auth/schemas/messages.schema.json";
const ajv = new Ajv({ allErrors: false });
addFormats(ajv);
ajv.addSchema(auth, "auth-messages.schema.json");
ajv.addSchema(common, "common.schema.json");
ajv.addSchema(commands, "commands.schema.json");
ajv.addSchema(messages, "messages.schema.json");
/** Проверяет DTO без преобразования и удаления полей; schema — определение владельца. */
export function valid(schema: string, data: unknown): boolean {
 return Boolean(ajv.validate(schema, data));
}
