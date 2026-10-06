export type AvailableChartColorsKeys =
  | "primary"
  | "muted"
  | "blue"
  | "emerald"
  | "violet"
  | "amber"
  | "gray"
  | "cyan"
  | "pink"
  | "lime"
  | "indigo"
  | "rose";

export const AvailableChartColors: AvailableChartColorsKeys[] = [
  "blue",
  "emerald",
  "violet",
  "amber",
  "gray",
  "cyan",
  "pink",
  "lime",
  "indigo",
  "rose",
];

const colorClassNames: Record<AvailableChartColorsKeys, { bg: string; fill: string }> = {
  amber: { bg: "bg-amber-500", fill: "fill-amber-500" },
  blue: { bg: "bg-blue-500", fill: "fill-blue-500" },
  cyan: { bg: "bg-cyan-500", fill: "fill-cyan-500" },
  emerald: { bg: "bg-emerald-500", fill: "fill-emerald-500" },
  gray: { bg: "bg-gray-500", fill: "fill-gray-500" },
  indigo: { bg: "bg-indigo-500", fill: "fill-indigo-500" },
  lime: { bg: "bg-lime-500", fill: "fill-lime-500" },
  muted: { bg: "bg-muted-foreground", fill: "fill-muted-foreground" },
  pink: { bg: "bg-pink-500", fill: "fill-pink-500" },
  primary: { bg: "bg-primary", fill: "fill-primary" },
  rose: { bg: "bg-rose-500", fill: "fill-rose-500" },
  violet: { bg: "bg-violet-500", fill: "fill-violet-500" },
};

export function constructCategoryColors(
  categories: string[],
  colors: AvailableChartColorsKeys[],
) {
  const categoryColors = new Map<string, AvailableChartColorsKeys>();
  categories.forEach((category, index) => {
    categoryColors.set(category, colors[index % colors.length]);
  });
  return categoryColors;
}

export function getColorClassName(color: AvailableChartColorsKeys, type: "bg" | "fill") {
  return colorClassNames[color][type];
}

export function getYAxisDomain(autoMinValue: boolean, minValue?: number, maxValue?: number) {
  return [autoMinValue ? "auto" : minValue ?? 0, maxValue ?? "auto"];
}
