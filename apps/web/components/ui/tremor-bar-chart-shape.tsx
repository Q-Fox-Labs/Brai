// Tremor BarChart [v0.2.1]
/* eslint-disable @typescript-eslint/no-explicit-any */

"use client"

export function deepEqual<T>(obj1: T, obj2: T): boolean {
  if (obj1 === obj2) return true

  if (
    typeof obj1 !== "object" ||
    typeof obj2 !== "object" ||
    obj1 === null ||
    obj2 === null
  ) {
    return false
  }

  const keys1 = Object.keys(obj1) as Array<keyof T>
  const keys2 = Object.keys(obj2) as Array<keyof T>

  if (keys1.length !== keys2.length) return false

  for (const key of keys1) {
    if (!keys2.includes(key) || !deepEqual(obj1[key], obj2[key])) return false
  }

  return true
}

export const renderShape = (
  props: any,
  activeBar: any | undefined,
  activeLegend: string | undefined,
  layout: string,
) => {
  const { fillOpacity, name, payload, value } = props
  let { x, width, y, height } = props

  if (layout === "horizontal" && height < 0) {
    y += height
    height = Math.abs(height) // height must be a positive number
  } else if (layout === "vertical" && width < 0) {
    x += width
    width = Math.abs(width) // width must be a positive number
  }

  return (
    <rect
      x={x}
      y={y}
      width={width}
      height={height}
      rx={5}
      ry={5}
      opacity={
        activeBar || (activeLegend && activeLegend !== name)
          ? deepEqual(activeBar, { ...payload, value })
            ? fillOpacity
            : 0.3
          : fillOpacity
      }
    />
  )
}

//#region Legend
