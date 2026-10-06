// ABOUTME: Shows upload progress on the image, then a check that fades after one second.
import { useMemo } from "react";
export default function ImageUploadStatus({ progress, completedAt }: { progress: number | undefined; completedAt?: number }) {
  const fadeDelay = useMemo(() => completedAt === undefined ? 1 : (completedAt + 1000 - performance.now()) / 1000, [completedAt]);
  if (progress === undefined) return null;
  const complete = progress === 1;
  return <span className={`agent-image-upload${complete ? " is-complete" : ""}`} style={complete ? { animationDelay: `${fadeDelay}s` } : undefined} role={complete ? "status" : "progressbar"} aria-label={complete ? "Изображение загружено" : "Загрузка изображения"} aria-valuemin={complete ? undefined : 0} aria-valuemax={complete ? undefined : 100} aria-valuenow={complete ? undefined : Math.round(progress * 100)}>
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <circle className="agent-image-upload-track" cx="16" cy="16" r="13" />
      <circle className="agent-image-upload-fill" cx="16" cy="16" r="13" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - progress} />
      {complete && <path className="agent-image-upload-check" d="m9 16 5 5 9-10" />}
    </svg>
  </span>;
}
