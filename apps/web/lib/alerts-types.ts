// ABOUTME: Описывает браузерное представление публичного контракта alerts.
// ABOUTME: Wire-валидация принадлежит JSON Schema сервиса, а не этим TypeScript типам.
export type AlertCategory = { id: number; code: string; name: string; color: string; importance: 1 | 2 | 3 };
export type AlertSummary = { unread_count: number; category: AlertCategory | null };
export type AlertNotification = {
 id: string; service_id: string; type_id: number; scope_type: "user" | "system"; scope_id: string;
 title: string; text: string; data: Record<string, unknown>; occurred_at: string; recorded_at: string;
 category: AlertCategory & { description: string };
 type: { id: number; code: string; name: string; description: string; category_id: number };
 read_at: string | null;
};
export type AlertPage = { items: AlertNotification[]; next_cursor: string | null };
