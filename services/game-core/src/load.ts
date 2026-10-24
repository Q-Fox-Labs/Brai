// ABOUTME: Ограничивает одновременные операции GameCore через общий FIFO gate.
// ABOUTME: Отмена и deadline не прерывают уже выполняющийся SQL, но не принимают новые запросы.
import { limits, type OperationContext } from "./contracts.js";
import { GameCoreFault } from "./domain.js";
export function createLoadGate() {
  let active = 0; let accepting = true; const pending: Array<{ run: (context: OperationContext) => Promise<any>; resolve: (value: any) => void; reject: (error: unknown) => void; context: OperationContext }> = [];
  async function pump(): Promise<void> { while (accepting && active < limits.active && pending.length) { const item = pending.shift()!; active++; void item.run(item.context).then(item.resolve, item.reject).finally(() => { active--; void pump(); }); } }
  return { run<T>(run: (context: OperationContext) => Promise<T>, supplied?: Partial<OperationContext>): Promise<T> { if (!accepting) return Promise.reject(new GameCoreFault("BUSY")); const context: OperationContext = { deadlineAt: supplied?.deadlineAt ?? performance.now() + limits.deadlineMs, signal: supplied?.signal ?? new AbortController().signal, actorId: supplied?.actorId }; return new Promise<T>((resolve, reject) => { if (pending.length >= limits.queue) { reject(new GameCoreFault("BUSY")); return; } pending.push({ run, resolve, reject, context }); void pump(); }); }, stopAccepting() { accepting = false; for (const item of pending.splice(0)) item.reject(new GameCoreFault("BUSY")); }, async drain() { while (active || pending.length) await new Promise(resolve => setTimeout(resolve, 5)); } };
}
export type LoadGate = ReturnType<typeof createLoadGate>;
