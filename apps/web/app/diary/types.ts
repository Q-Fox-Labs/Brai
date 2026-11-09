// ABOUTME: Описывает публичные данные Дневника для загрузки и чтения.
// ABOUTME: Владелец и служебные секреты не задаются пользовательским вводом.
export type DiaryState = "awaiting_upload" | "transcribing" | "correcting" | "ready" | "needs_attention";
export type DiarySummary = {
  id: string; title: string; source: "audio" | "text"; state: DiaryState;
  createdAt: string; eventDate: string | null;
  audioProgress?: {totalFrames: number; sampleRate: number; totalParts: number; transcribedFrames: number; correctedFrames: number; completedParts: number};
  dateStatus: "needs_clarification" | "identified" | "provided";
  dateEvidence: string; audioArtifactId: string | null; errorCode: string | null;
};
export type DiaryEntry = DiarySummary & {
  rawText: string | null; correctedText: string | null;
  transcriptionRetry?: {key: string};
  transcription: { requestId: string; actualModel: unknown } | null;
  correction: { model: string; promptVersion: string; completedAt: string; rawResponse: string } | null;
};
