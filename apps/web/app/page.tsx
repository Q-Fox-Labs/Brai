// ABOUTME: Собирает единственную страницу общего таймера Brai.
// ABOUTME: Client lifecycle и представление находятся в компоненте Timer.
import Timer from "./timer";
/** Отображает страницу таймера без серверного state prefetch до SSE. */
export default function HomePage() { return <Timer />; }
