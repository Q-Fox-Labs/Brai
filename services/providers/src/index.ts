// ABOUTME: Публичная точка входа клиента и принадлежащих providers DTO.
// ABOUTME: Не экспортирует PG, runtime или внутренние адаптеры модели.
export {createProvidersClient} from './client.js';
export type {OperationView,ChatInput} from './client.js';
export {Failure} from './core.js';
export type {ChatRequest,ChatResult,Tool,ToolCall,StreamEvent,Usage} from './chat.js';
export type {DecideRequest,Phase} from './operations.js';
export type {ImageRequest} from './image.js';
