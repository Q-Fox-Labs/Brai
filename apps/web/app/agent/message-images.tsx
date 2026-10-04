// ABOUTME: Загружает изображения сообщения из native истории и показывает миниатюры.
// ABOUTME: Ограниченный общий кеш управляет чтениями; поздние ответы покинутого чата отбрасываются.
import { useEffect, useState } from "react";
import type { DisplayItem } from "@brai/agent/contracts";
import type { LazyReads } from "../../lib/agent/lazy";
type Props = { item: DisplayItem; context: { generation: string; epoch: string; projectId: string; threadId: string }; reads: LazyReads };

/** Читает вложения отдельно от компактной истории, с возможностью повторить ошибочное чтение. */
export default function MessageImages({ item, context, reads }: Props) {
  const [images, setImages] = useState<string[] | null>(null), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setImages(null); setError(false);
    void reads.detail(context, item).then(value => { if (current) setImages(value.images ?? []); }).catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [reads, context.generation, context.epoch, context.projectId, context.threadId, item.id, item.turnId, item.revision, retry]);
  return <div className="agent-message-images">
    {images?.length ? <ul className="agent-message-thumbnails" aria-label="Изображения сообщения">{images.map((url, index) => <li key={index}><img src={url} alt={`Прикреплённое изображение ${index + 1}`} /></li>)}</ul> : <p>{error ? "Не удалось загрузить изображения." : images ? `Изображений: ${item.imageCount}. Предпросмотр недоступен.` : "Загружаем изображения…"}</p>}
    {error && <button type="button" onClick={() => setRetry(value => value + 1)}>Повторить</button>}
  </div>;
}
