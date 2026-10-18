// ABOUTME: Выводит публичные capabilities и LiteLLM routes из одного каталога.
// ABOUTME: Не читает ключи и не объявляет неизвестные возможности поддержанными.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
export type ModelCard = {provider: string; model: string; capabilities: string[]; questionTypes: string[]; stateTypes: string[]; deadlineMs: number};
type Entry = ModelCard & {upstreamModel: string; apiKeyEnv: string};
const config: {version: string; models: Entry[]} = JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8"));
if (!/^[a-zA-Z0-9._-]{1,128}$/.test(config.version) || config.models.length !== 3 || new Set(config.models.map(m=>m.provider+"/"+m.model)).size!==3 || config.models.some(m => !Number.isInteger(m.deadlineMs) || m.deadlineMs<1 || (m.provider==="typesafe" ? m.model!=="jev-1.13.0"||m.upstreamModel!=="typesafe/jev-1.13.0"||m.apiKeyEnv!=="TYPESAFE_API_KEY"||m.capabilities.join()!=="decide"||m.questionTypes.join()!=="noul,choice,score"||m.stateTypes.join()!=="string,object,array"||m.deadlineMs>30000 : m.model==="google/gemini-2.5-flash-image" ? m.provider!=="openrouter"||m.upstreamModel!=="openrouter/google/gemini-2.5-flash-image"||m.apiKeyEnv!=="OPENROUTER_API_KEY"||m.capabilities.join()!=="image"||m.questionTypes.length!==0||m.stateTypes.length!==0||m.deadlineMs>180000 : m.provider!=="openrouter"||m.model!=="deepseek/deepseek-v3.2"||m.upstreamModel!=="openrouter/deepseek/deepseek-v3.2"||m.apiKeyEnv!=="OPENROUTER_API_KEY"||m.capabilities.join()!=="chat,stream,tools"||m.questionTypes.length!==0||m.stateTypes.length!==0||m.deadlineMs>90000))) throw new Error("INVALID_CATALOG");
export const catalogVersion = config.version;
/** Возвращает только безопасные поля; вызывающий получает собственную копию. */
export function listModels(): ModelCard[] {return config.models.map(({upstreamModel, apiKeyEnv, ...card}) => structuredClone(card));}
/** Не делает health/inference, отсутствие маршрута возвращает undefined. */
export function getModel(provider: string, model: string) {return listModels().find(m => m.provider === provider && m.model === model);}
/** JSON является допустимым YAML; файл генерируется, ручные маршруты не добавляются. */
export function liteLLMConfig() {
  return JSON.stringify({model_list: config.models.map(m => ({model_name:m.model,litellm_params:{model:m.upstreamModel,api_key:`os.environ/${m.apiKeyEnv}`,num_retries:0,max_retries:0,timeout:m.deadlineMs/1000,configurable_clientside_auth_params:[{api_base:`^http://127[.]0[.]0[.]1:18401/dispatch/[a-f0-9-]{36}${m.provider==="openrouter"?"/v1":""}\\Z`}]}})),router_settings:{num_retries:0,fallbacks:[],context_window_fallbacks:[],content_policy_fallbacks:[],timeout:180},litellm_settings:{num_retries:0,drop_params:false,set_verbose:false,turn_off_message_logging:true,request_timeout:180},general_settings:{disable_background_health_check:true}},null,2)+"\n";
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) writeFileSync(new URL("../litellm.yaml", import.meta.url), liteLLMConfig());
