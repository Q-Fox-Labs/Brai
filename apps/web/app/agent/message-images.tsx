// ABOUTME: Показывает новые HTTP миниатюры и явное состояние старых или удалённых файлов.
// ABOUTME: Не читает native media; повтор для недоступной привязки обходит detail cache.
import { useEffect, useState } from "react";
import type { DisplayItem } from "@brai/agent/contracts";
import type { LazyReads } from "../../lib/agent/lazy";
type Props = { item: DisplayItem; context: { generation: string; epoch: string; projectId: string; threadId: string }; reads: LazyReads };

/** Отображает owner descriptors прямо из DTO; старые сообщения сохраняют только счётчик. */
export default function MessageImages({ item, context, reads }: Props) {
  const [detail, setDetail] = useState<DisplayItem | null>(null), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  const [failedImages, setFailedImages] = useState<Set<string>>(() => new Set()), [imageRetry, setImageRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setDetail(null); setError(false); setFailedImages(new Set()); setImageRetry(0);
    if (retry === 0 && (item.attachments || item.attachmentsState)) {
      setDetail(item);
      return () => { current = false; };
    }
    if (!item.imageCount && !item.attachmentsState) return () => { current = false; };
    void reads.detail(context, item, retry > 0).then(value => { if (current) setDetail(value); }).catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [reads, context.generation, context.epoch, context.projectId, context.threadId, item.id, item.turnId, item.revision, item.imageCount, item.attachments, item.attachmentsState, retry]);

  const values = detail?.attachments ?? [];
  const ready = values.filter(value => value.status === "ready" && value.url);
  const deleted = values.filter(value => value.status === "deleted").length;
  const unavailable = values.filter(value => value.status === "unavailable" || value.status === "ready" && !value.url).length;
  const retryDetails = () => { setError(false); setRetry(value => value + 1); };
  const retryImages = () => { setFailedImages(new Set()); setImageRetry(value => value + 1); setRetry(value => value + 1); };
  return <div className="agent-message-images">
    {!!ready.length && <ul className="agent-message-thumbnails" aria-label="Изображения сообщения">{ready.map((attachment, index) => <li key={`${attachment.modelArtifactId}:${imageRetry}`}>
      {failedImages.has(attachment.modelArtifactId) ? <span role="status">Миниатюра пока недоступна.</span> : <img src={attachment.url} alt={`Прикреплённое изображение ${index + 1}`} onError={() => setFailedImages(previous => new Set(previous).add(attachment.modelArtifactId))} />}
    </li>)}</ul>}
    {deleted > 0 && <p role="status">{deleted === 1 ? "Вложение удалено из хранилища." : `Удалено вложений: ${deleted}.`}</p>}
    {(unavailable > 0 || detail?.attachmentsState === "unavailable") && <p role="status">{unavailable === 1 ? "Миниатюра пока недоступна." : "Не удалось получить сведения о вложениях."}</p>}
    {!detail && <p>{error ? "Не удалось загрузить сведения об изображении." : "Загружаем сведения об изображении…"}</p>}
    {detail && !values.length && !!item.imageCount && <p>Изображений: {item.imageCount}. Предпросмотр недоступен.</p>}
    {error && <button type="button" onClick={retryDetails}>Повторить</button>}
    {(unavailable > 0 || detail?.attachmentsState === "unavailable") && <button type="button" onClick={retryDetails}>Повторить чтение вложений</button>}
    {failedImages.size > 0 && <button type="button" onClick={retryImages}>Повторить загрузку миниатюры</button>}
  </div>;
}
