"use client";
// ABOUTME: Показывает цели таймера по полной Statistics владельца.
// ABOUTME: Компонент форматирует готовые значения и не пересчитывает статистику.
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { BarChart, type TooltipProps } from "@/components/ui/tremor-bar-chart";
import type { Day, Statistics } from "../lib/types";
import "./timer-goals.css";

const chartCategories = ["Цель выполнена", "Время фокуса"];

type ChartRow = {
 date: string;
 completedMs: number;
 percent: number;
 achieved: boolean;
 "Цель выполнена": number;
 "Время фокуса": number;
};

type Props = {
 statistics: Statistics | null;
 loading: boolean;
 onRefresh?: () => void;
};

/** Показывает готовые дневные и общие показатели сервиса, включая весь график челленджа. */
export default function TimerGoals({ statistics, loading, onRefresh }: Props) {
 if (loading && !statistics) {
  return <section aria-label="Цели таймера" aria-live="polite" className="timer-goals-state"><p>Загружаем цели…</p></section>;
 }
 if (!statistics) {
  return <section aria-label="Цели таймера" className="timer-goals-state">
   <p>Данные о целях недоступны.</p>
   {onRefresh ? <Button onClick={onRefresh} type="button" variant="outline">Повторить</Button> : null}
  </section>;
 }

 const { challenge } = statistics;
 const todayParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: statistics.timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
 }).formatToParts(new Date(statistics.serverTime));
 const todayDate = Object.fromEntries(todayParts.map(({ type, value }) => [type, value]));
 const todayKey = `${todayDate.year}-${todayDate.month}-${todayDate.day}`;
 const today = statistics.daily.find((day) => day.date === todayKey);
 const chartData = challenge.daily.map(chartRow);

 return <section aria-label="Цели таймера" aria-busy={loading} className="timer-goals">
  <div className="timer-goals-progress-grid">
   <GoalProgressCard
   detail={`${formatGoalDuration(challenge.completedMs)} из ${formatGoalDuration(challenge.targetMs)}`}
   detailTitle={`${challenge.completedMs} мс из ${challenge.targetMs} мс`}
    label="Общий прогресс"
    value={challenge.percent}
   />
   <GoalProgressCard
   detail={`${formatGoalDuration(today?.completedMs ?? 0)} из ${formatGoalDuration(challenge.dailyTargetMs)}`}
   detailTitle={`${today?.completedMs ?? 0} мс из ${challenge.dailyTargetMs} мс`}
    label="Сегодня"
    value={today?.percent ?? 0}
    valueClassName="text-primary"
   />
  </div>

  <div className="timer-goals-metrics">
   <Metric label="Выполнено" value={formatGoalDuration(challenge.completedMs)} exactMs={challenge.completedMs} detail="суммарно" />
   <Metric label="Осталось" value={formatGoalDuration(challenge.remainingMs)} exactMs={challenge.remainingMs} detail={`${challenge.remainingDays} дн.`} />
   <Metric label="Нужно в день" value={formatGoalDuration(challenge.requiredDailyMs)} exactMs={challenge.requiredDailyMs} detail="до финиша" />
   <Metric label="Дней закрыто" value={String(challenge.closedDays)} detail={`из ${challenge.days}`} />
  </div>

  <Card className="timer-goals-chart-card">
   {chartData.length > 0 ? <div className="timer-goals-chart">
    <BarChart
     className="h-64"
     data={chartData}
     index="date"
     categories={chartCategories}
     colors={["primary", "muted"]}
     type="stacked"
     yAxisWidth={60}
     valueFormatter={formatGoalChartHours}
     customTooltip={GoalChartTooltip}
    />
   </div> : <p className="timer-goals-chart-empty">Нет данных за период цели.</p>}
  </Card>
 </section>;
}

function chartRow(day: Day): ChartRow {
 const hours = day.completedMs / 3_600_000;
 return {
  date: formatGoalChartDate(day.date),
  completedMs: day.completedMs,
  percent: day.percent,
  achieved: day.achieved,
  "Цель выполнена": day.achieved ? hours : 0,
  "Время фокуса": day.achieved ? 0 : hours,
 };
}

function GoalProgressCard({
 detail,
 detailTitle,
 label,
 value,
 valueClassName,
}: {
 detail: string;
 detailTitle: string;
 label: string;
 value: number;
 valueClassName?: string;
}) {
 const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
 const progressValue = Math.min(100, safeValue);

 return <Card className="timer-goals-progress-card">
  <div className="timer-goals-progress-heading">
   <span>{label}</span>
   <span className={valueClassName}>{formatPercent(safeValue)}</span>
  </div>
  <Progress aria-label={label} value={progressValue} />
  <small title={detailTitle}>{detail}</small>
 </Card>;
}

function GoalChartTooltip({ active, payload, label }: TooltipProps) {
 if (!active || !payload?.length) return null;
 const visiblePayload = payload.find((item) => item.value > 0)
  ?? payload.find((item) => item.category === "Время фокуса")
  ?? payload[0];
 const source = visiblePayload.payload as Pick<ChartRow, "completedMs" | "percent">;
 const isAchieved = visiblePayload.category === "Цель выполнена";

 return <Card className="timer-goals-tooltip">
  <div className="timer-goals-tooltip-date">{label}</div>
  <div className="timer-goals-tooltip-content">
   <div className="timer-goals-tooltip-category">
    <span aria-hidden="true" className={isAchieved ? "is-achieved" : ""} />
    <span>{visiblePayload.category}</span>
   </div>
   <div className="timer-goals-tooltip-values">
    <span>{formatPercent(source.percent)} цели</span>
    <span title={`${source.completedMs} мс`}>{formatGoalDuration(source.completedMs)}</span>
   </div>
  </div>
 </Card>;
}

function Metric({ label, value, exactMs, detail }: { label: string; value: string; exactMs?: number; detail: string }) {
 return <Card className="timer-goals-metric">
  <span>{label}</span>
  <strong title={exactMs === undefined ? value : `${exactMs} мс`}>{value}</strong>
  <small>{detail}</small>
 </Card>;
}

function formatGoalChartHours(value: number): string {
 return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value)} ч`;
}

function formatGoalDuration(milliseconds: number): string {
 return formatDurationSeconds(milliseconds / 1000);
}

function formatDurationSeconds(seconds: number): string {
 const safe = Math.max(0, Math.round(seconds));
 const hours = Math.floor(safe / 3600);
 const minutes = Math.floor((safe % 3600) / 60);
 if (hours === 0 && minutes === 0) return "0м";
 if (hours === 0) return `${minutes}м`;
 if (minutes === 0) return `${hours}ч`;
 return `${hours}ч ${minutes}м`;
}

function formatPercent(value: number): string {
 const safe = Number.isFinite(value) ? value : 0;
 if (safe === 0) return "0%";
 if (safe < 100) return `${safe.toFixed(1).replace(".", ",")}%`;
 return `${safe.toFixed(0)}%`;
}

function formatGoalChartDate(date: string): string {
 const [, month, day] = date.split("-");
 return month && day ? `${day}-${month}` : date;
}
