"use client";
// ABOUTME: Показывает готовую команду приглашения в личный чат Telegram.
// ABOUTME: Не строит ссылку на бота и не отправляет приглашение самостоятельно.
import { useState } from "react";
/** Даёт скопировать точную команду и объясняет её назначение и срок действия. */
export function InviteCommand({ code }: { code: string }) {
 const [message, setMessage] = useState("");
 const command = `/start invite_${code}`;
 async function copy() {
  try { await navigator.clipboard.writeText(command); setMessage("Команда скопирована."); }
  catch { setMessage("Не удалось скопировать. Выделите команду и скопируйте её вручную."); }
 }
 return <div className="admin-invite-command">
  <p>Передайте эту команду другому человеку. Ему нужно отправить её в личном чате с этим ботом в Telegram.</p>
  <p>Приглашение действует 24 часа и используется один раз.</p>
  <code>{command}</code><button type="button" onClick={() => void copy()}>Скопировать команду</button><p role="status">{message}</p>
 </div>;
}
