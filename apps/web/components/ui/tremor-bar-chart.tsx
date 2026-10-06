// Tremor BarChart [v0.2.1]
/* eslint-disable @typescript-eslint/no-explicit-any */

"use client"

import React from "react"
import {
  Bar,
  CartesianGrid,
  Label,
  BarChart as RechartsBarChart,
  Legend as RechartsLegend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import type { AxisDomain } from "recharts/types/util/types"

import {
  AvailableChartColors,
  constructCategoryColors,
  getColorClassName,
  getYAxisDomain,
} from "@/lib/chartUtils"
import type { AvailableChartColorsKeys } from "@/lib/chartUtils"
import { cx } from "@/lib/utils"
import { ChartLegend } from "./tremor-bar-chart-legend"
import { deepEqual, renderShape } from "./tremor-bar-chart-shape"
import { ChartTooltip, type TooltipProps } from "./tremor-bar-chart-tooltip"

type BaseEventProps = {
  eventType: "category" | "bar"
  categoryClicked: string
  [key: string]: number | string
}

type BarChartEventProps = BaseEventProps | null | undefined

interface BarChartProps extends React.HTMLAttributes<HTMLDivElement> {
  data: Record<string, any>[]
  index: string
  categories: string[]
  colors?: AvailableChartColorsKeys[]
  valueFormatter?: (value: number) => string
  startEndOnly?: boolean
  showXAxis?: boolean
  showYAxis?: boolean
  showGridLines?: boolean
  yAxisWidth?: number
  intervalType?: "preserveStartEnd" | "equidistantPreserveStart"
  showTooltip?: boolean
  showLegend?: boolean
  autoMinValue?: boolean
  minValue?: number
  maxValue?: number
  allowDecimals?: boolean
  onValueChange?: (value: BarChartEventProps) => void
  enableLegendSlider?: boolean
  tickGap?: number
  barCategoryGap?: string | number
  xAxisLabel?: string
  yAxisLabel?: string
  layout?: "vertical" | "horizontal"
  type?: "default" | "stacked" | "percent"
  legendPosition?: "left" | "center" | "right"
  tooltipCallback?: (tooltipCallbackContent: TooltipProps) => void
  customTooltip?: React.ComponentType<TooltipProps>
}

const BarChart = React.forwardRef<HTMLDivElement, BarChartProps>(
  (props, forwardedRef) => {
    const {
      data = [],
      categories = [],
      index,
      colors = AvailableChartColors,
      valueFormatter = (value: number) => value.toString(),
      startEndOnly = false,
      showXAxis = true,
      showYAxis = true,
      showGridLines = true,
      yAxisWidth = 56,
      intervalType = "equidistantPreserveStart",
      showTooltip = true,
      showLegend = true,
      autoMinValue = false,
      minValue,
      maxValue,
      allowDecimals = true,
      className,
      onValueChange,
      enableLegendSlider = false,
      barCategoryGap,
      tickGap = 5,
      xAxisLabel,
      yAxisLabel,
      layout = "horizontal",
      type = "default",
      legendPosition = "right",
      tooltipCallback,
      customTooltip,
      ...other
    } = props
    const CustomTooltip = customTooltip
    const paddingValue =
      (!showXAxis && !showYAxis) || (startEndOnly && !showYAxis) ? 0 : 20
    const [legendHeight, setLegendHeight] = React.useState(60)
    const [activeLegend, setActiveLegend] = React.useState<string | undefined>(
      undefined,
    )
    const categoryColors = constructCategoryColors(categories, colors)
    const [activeBar, setActiveBar] = React.useState<any | undefined>(undefined)
    const yAxisDomain = getYAxisDomain(autoMinValue, minValue, maxValue)
    const hasOnValueChange = !!onValueChange
    const stacked = type === "stacked" || type === "percent"

    const prevActiveRef = React.useRef<boolean | undefined>(undefined)
    const prevLabelRef = React.useRef<string | undefined>(undefined)

    function valueToPercent(value: number) {
      return `${(value * 100).toFixed(0)}%`
    }

    function onBarClick(data: any, _: any, event: React.MouseEvent) {
      event.stopPropagation()
      if (!onValueChange) return
      if (deepEqual(activeBar, { ...data.payload, value: data.value })) {
        setActiveLegend(undefined)
        setActiveBar(undefined)
        onValueChange?.(null)
      } else {
        setActiveLegend(data.tooltipPayload?.[0]?.dataKey)
        setActiveBar({
          ...data.payload,
          value: data.value,
        })
        onValueChange?.({
          eventType: "bar",
          categoryClicked: data.tooltipPayload?.[0]?.dataKey,
          ...data.payload,
        })
      }
    }

    function onCategoryClick(dataKey: string) {
      if (!hasOnValueChange) return
      if (dataKey === activeLegend && !activeBar) {
        setActiveLegend(undefined)
        onValueChange?.(null)
      } else {
        setActiveLegend(dataKey)
        onValueChange?.({
          eventType: "category",
          categoryClicked: dataKey,
        })
      }
      setActiveBar(undefined)
    }

    return (
      <div
        ref={forwardedRef}
        className={cx("h-80 w-full", className)}
        tremor-id="tremor-raw"
        {...other}
      >
        <ResponsiveContainer>
          <RechartsBarChart
            data={data}
            onClick={
              hasOnValueChange && (activeLegend || activeBar)
                ? () => {
                    setActiveBar(undefined)
                    setActiveLegend(undefined)
                    onValueChange?.(null)
                  }
                : undefined
            }
            margin={{
              bottom: xAxisLabel ? 30 : undefined,
              left: yAxisLabel ? 20 : undefined,
              right: yAxisLabel ? 5 : undefined,
              top: 5,
            }}
            stackOffset={type === "percent" ? "expand" : undefined}
            layout={layout}
            barCategoryGap={barCategoryGap}
          >
            {showGridLines ? (
              <CartesianGrid
                className={cx("stroke-gray-200 stroke-1 dark:stroke-gray-800")}
                stroke="var(--border)"
                horizontal={layout !== "vertical"}
                vertical={layout === "vertical"}
              />
            ) : null}
            <XAxis
              hide={!showXAxis}
              tick={{
                fill: "var(--muted-foreground)",
                transform:
                  layout !== "vertical" ? "translate(0, 6)" : undefined,
              }}
              fill=""
              stroke=""
              className={cx(
                // base
                "text-xs",
                // text fill
                "fill-gray-500 dark:fill-gray-500",
                { "mt-4": layout !== "vertical" },
              )}
              tickLine={false}
              axisLine={false}
              minTickGap={tickGap}
              {...(layout !== "vertical"
                ? {
                    padding: {
                      left: paddingValue,
                      right: paddingValue,
                    },
                    dataKey: index,
                    interval: startEndOnly ? "preserveStartEnd" : intervalType,
                    ticks: startEndOnly
                      ? [data[0][index], data[data.length - 1][index]]
                      : undefined,
                  }
                : {
                    type: "number",
                    domain: yAxisDomain as AxisDomain,
                    tickFormatter:
                      type === "percent" ? valueToPercent : valueFormatter,
                    allowDecimals: allowDecimals,
                  })}
            >
              {xAxisLabel && (
                <Label
                  position="insideBottom"
                  offset={-20}
                  fill="var(--foreground)"
                  className="fill-gray-800 text-sm font-medium dark:fill-gray-200"
                >
                  {xAxisLabel}
                </Label>
              )}
            </XAxis>
            <YAxis
              width={yAxisWidth}
              hide={!showYAxis}
              axisLine={false}
              tickLine={false}
              fill=""
              stroke=""
              className={cx(
                // base
                "text-xs",
                // text fill
                "fill-gray-500 dark:fill-gray-500",
              )}
              tick={{
                fill: "var(--muted-foreground)",
                transform:
                  layout !== "vertical"
                    ? "translate(-3, 0)"
                    : "translate(0, 0)",
              }}
              {...(layout !== "vertical"
                ? {
                    type: "number",
                    domain: yAxisDomain as AxisDomain,
                    tickFormatter:
                      type === "percent" ? valueToPercent : valueFormatter,
                    allowDecimals: allowDecimals,
                  }
                : {
                    dataKey: index,
                    ticks: startEndOnly
                      ? [data[0][index], data[data.length - 1][index]]
                      : undefined,
                    type: "category",
                    interval: "equidistantPreserveStart",
                  })}
            >
              {yAxisLabel && (
                <Label
                  position="insideLeft"
                  style={{ textAnchor: "middle" }}
                  angle={-90}
                  offset={-15}
                  fill="var(--foreground)"
                  className="fill-gray-800 text-sm font-medium dark:fill-gray-200"
                >
                  {yAxisLabel}
                </Label>
              )}
            </YAxis>
            <Tooltip
              wrapperStyle={{ outline: "none" }}
              isAnimationActive={true}
              animationDuration={100}
              cursor={{ fill: "#d1d5db", opacity: "0.15" }}
              offset={20}
              position={{
                y: layout === "horizontal" ? 0 : undefined,
                x: layout === "horizontal" ? undefined : yAxisWidth + 20,
              }}
              content={({ active, payload, label }) => {
                const tooltipLabel = String(label ?? "")
                const cleanPayload: TooltipProps["payload"] = payload
                  ? payload.map((item: any) => ({
                      category: item.dataKey,
                      value: item.value,
                      index: item.payload[index],
                      color: categoryColors.get(
                        item.dataKey,
                      ) as AvailableChartColorsKeys,
                      type: item.type,
                      payload: item.payload,
                    }))
                  : []

                if (
                  tooltipCallback &&
                  (active !== prevActiveRef.current ||
                    tooltipLabel !== prevLabelRef.current)
                ) {
                  tooltipCallback({
                    active,
                    payload: cleanPayload,
                    label: tooltipLabel,
                  })
                  prevActiveRef.current = active
                  prevLabelRef.current = tooltipLabel
                }

                return showTooltip && active ? (
                  CustomTooltip ? (
                    <CustomTooltip
                      active={active}
                      payload={cleanPayload}
                      label={tooltipLabel}
                    />
                  ) : (
                    <ChartTooltip
                      active={active}
                      payload={cleanPayload}
                      label={tooltipLabel}
                      valueFormatter={valueFormatter}
                    />
                  )
                ) : null
              }}
            />
            {showLegend ? (
              <RechartsLegend
                verticalAlign="top"
                height={legendHeight}
                content={({ payload }) =>
                  ChartLegend(
                    { payload },
                    categoryColors,
                    setLegendHeight,
                    activeLegend,
                    hasOnValueChange
                      ? (clickedLegendItem: string) =>
                          onCategoryClick(clickedLegendItem)
                      : undefined,
                    enableLegendSlider,
                    legendPosition,
                    yAxisWidth,
                  )
                }
              />
            ) : null}
            {categories.map((category) => (
              <Bar
                className={cx(
                  getColorClassName(
                    categoryColors.get(category) as AvailableChartColorsKeys,
                    "fill",
                  ),
                  onValueChange ? "cursor-pointer" : "",
                )}
                key={category}
                name={category}
                type="linear"
                dataKey={category}
                stackId={stacked ? "stack" : undefined}
                isAnimationActive={false}
                fill=""
                shape={(props: any) =>
                  renderShape(props, activeBar, activeLegend, layout)
                }
                onClick={onBarClick}
              />
            ))}
          </RechartsBarChart>
        </ResponsiveContainer>
      </div>
    )
  },
)

BarChart.displayName = "BarChart"

export { BarChart, type BarChartEventProps, type TooltipProps }
