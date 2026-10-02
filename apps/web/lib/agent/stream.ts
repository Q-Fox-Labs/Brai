// ABOUTME: Сжимает живой поток стандартным AG-UI STATE_DELTA между полными снимками.
// ABOUTME: Проверяет исходную базу RFC6902; пропущенная база требует нового open.
import jsonPatch, { type Operation } from "fast-json-patch";
import { EventSchema } from "@ag-ui/core/schemas";
import { bytes, limits, validateEnvelope } from "@brai/agent/contracts";
import type { EventEnvelope, NativeSnapshot } from "@brai/agent/contracts";
type DeltaFrame = Omit<EventEnvelope, "event"> & { baseSeq: number; event: { type: "STATE_DELTA"; delta: Operation[] } };
export type StreamFrame = EventEnvelope | DeltaFrame;
/** Полный снимок начинает epoch; следующие кадры несут только изменившиеся поля. */
export function encodeFrame(value: EventEnvelope, previous?: NativeSnapshot): StreamFrame {
  if (!previous || previous.generation !== value.generation || previous.epoch !== value.epoch) return value;
  const patch: DeltaFrame = { ...value, baseSeq: previous.seq, event: { type: "STATE_DELTA", delta: jsonPatch.compare(previous, value.event.snapshot) } };
  return bytes(patch) < bytes(value) ? patch : value;
}
/** Возвращает проверенный полный снимок. Несовпадение базы не допускает частичного применения. */
export function decodeFrame(value: StreamFrame, previous?: NativeSnapshot | null): NativeSnapshot {
  if (value.event?.type === "STATE_SNAPSHOT") {
    if (!validateEnvelope(value) || bytes(value.event.snapshot) > limits.state) throw new Error("BAD_EVENT");
    EventSchema.parse(value.event);
    return value.event.snapshot;
  }
  if (!("baseSeq" in value) || value.event?.type !== "STATE_DELTA" || bytes(value) > limits.frame || !Number.isSafeInteger(value.baseSeq) || !Number.isSafeInteger(value.seq) || value.seq <= value.baseSeq) throw new Error("BAD_EVENT");
  if (!previous || previous.projectId !== value.projectId || previous.threadId !== value.threadId || previous.generation !== value.generation || previous.epoch !== value.epoch || previous.seq !== value.baseSeq) throw new Error("STREAM_BASE_MISMATCH");
  EventSchema.parse(value.event);
  const snapshot = jsonPatch.applyPatch(previous, value.event.delta, true, false, true).newDocument as NativeSnapshot;
  const envelope = { projectId: value.projectId, threadId: value.threadId, generation: value.generation, epoch: value.epoch, seq: value.seq, event: { type: "STATE_SNAPSHOT", snapshot } };
  if (!validateEnvelope(envelope) || bytes(snapshot) > limits.state) throw new Error("BAD_EVENT");
  return snapshot;
}
