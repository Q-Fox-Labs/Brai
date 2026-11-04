// ABOUTME: Определяет данные интерфейса Дневника.
// ABOUTME: Не включает внутренние URL, владельцев и ключи загрузки.
export type DiarySummary = { id: string; title: string; date: string | null; createdAt: string };
export type DiaryMaterial = { id: string; filename: string; mimeType: string; sizeBytes: number | null; sha256: string | null; status: string; role: string };
export type DiaryEntry = DiarySummary & { text: string; materials: DiaryMaterial[]; materialsTotal: number };
