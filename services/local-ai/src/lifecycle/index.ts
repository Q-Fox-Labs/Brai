// ABOUTME: Публикует runtime factory и менеджер как внутреннюю границу lifecycle local-ai.
// ABOUTME: Внешние сценарии передают только закреплённые профили и конечные ограничения.
export { createLifecycleManager } from './manager.js';
export type {
  EmbedInvocation, Invocation, InvocationResult, LifecycleLimits, LifecycleManager, LifecycleManagerOptions,
  LifecycleStatus, TranscribeInvocation, SynthesizeInvocation,
} from './manager.js';
export { createProfileRuntimeFactory } from './runtime-factory.js';
export type { ProfileRuntimeFactoryConfig } from './runtime-factory.js';
