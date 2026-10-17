import type {
  ContributionMetric,
  ContributionShareChart,
  ContributionShareGroup,
  ContributionWindow
} from "@pwrgit/shared";

/**
 * The picture Contributions puts on the clipboard.
 *
 * It is drawn from a `ContributionShareChart`, whose labels were resolved —
 * and masked — before they got here, and nothing else: no live DOM, no
 * per-bar `<title>`, no metadata. The preview shows this exact SVG, and the
 * PNG is this SVG rasterized, so what the user checks is what they paste.
 *
 * Colors are literals, deliberately. The image leaves the app, so it cannot
 * follow theme tokens; `lint-renderer-colors.mjs` covers CSS only and leaves
 * colors in `.ts` to a manual pass, which this comment is.
 */

export type ShareTheme = "light" | "dark";
export type ShareInterval = "day" | "week" | "month";

/** Logical size; the PNG is drawn at `SHARE_IMAGE_SCALE` times this. */
export const SHARE_IMAGE_WIDTH = 900;
export const SHARE_IMAGE_HEIGHT = 380;
export const SHARE_IMAGE_SCALE = 2;

const PALETTES: Record<
  ShareTheme,
  {
    background: string;
    title: string;
    tick: string;
    grid: string;
    other: string;
    series: readonly string[];
  }
> = {
  // Tableau 10: distinct at bar width on white, and familiar from the
  // charts people already paste.
  light: {
    background: "#ffffff",
    title: "#1a1612",
    tick: "#3d3730",
    grid: "rgba(26, 22, 18, 0.10)",
    other: "#bab0ac",
    series: [
      "#4e79a7",
      "#f28e2b",
      "#e15759",
      "#76b7b2",
      "#59a14f",
      "#edc948",
      "#b07aa1",
      "#ff9da7"
    ]
  },
  // The app's dark lane colors (tokens.css --lane-1..8, --lane-1 = accent).
  dark: {
    background: "#0a0a0a",
    title: "#f7f3eb",
    tick: "#b8b0a5",
    grid: "rgba(247, 243, 235, 0.12)",
    other: "#5c564f",
    series: [
      "#ff8a1f",
      "#62c882",
      "#7aa2f7",
      "#e5b566",
      "#bd8ff0",
      "#ef7f95",
      "#58cfc0",
      "#a9b665"
    ]
  }
};

// System faces only: an SVG drawn as an image cannot reach the document's
// web fonts, and the preview and the PNG must render the same glyphs.
const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];
/** Legend labels past this are cut, so one long repo path cannot eat the plot. */
const LEGEND_MAX_CHARS = 28;

export function shareColor(
  theme: ShareTheme,
  index: number,
  other: boolean
): string {
  const palette = PALETTES[theme];
  return other ? palette.other : palette.series[index % palette.series.length]!;
}

/** "PRs merged by avery-q · Aug 1 – Oct 11, 2026 · today partial (UTC)". */
export function shareImageTitle({
  metric,
  login,
  group,
  interval,
  window
}: {
  metric: ContributionMetric;
  login: string | null;
  group: ContributionShareGroup;
  interval: ShareInterval;
  window: ContributionWindow;
}): string {
  const what = {
    merged: login ? `PRs merged by ${login}` : "PRs merged",
    authored: login
      ? `PRs by ${login} that were merged`
      : "Authored PRs that were merged",
    overlap: login ? `PRs ${login} authored and merged` : "Self-merged PRs",
    created: login ? `PRs created by ${login}` : "PRs created"
  }[metric];
  const cadence = { day: "", week: "Weekly ", month: "Monthly " }[interval];
  const by = group === "repo" ? " by repository" : "";
  const partial = window.partialDay ? " · today partial" : "";
  return `${cadence}${what}${by} · ${shareRange(window)}${partial} (${window.timezone})`;
}

function shareRange(window: ContributionWindow): string {
  const [startYear] = window.startDate.split("-");
  const [endYear] = window.endDate.split("-");
  const day = (date: string, withYear: boolean) => {
    const [year, month, dom] = date.split("-");
    return `${MONTHS[Number(month) - 1]} ${Number(dom)}${withYear ? `, ${year}` : ""}`;
  };
  return startYear === endYear
    ? `${day(window.startDate, false)} – ${day(window.endDate, true)}`
    : `${day(window.startDate, true)} – ${day(window.endDate, true)}`;
}

export function shareYAxisLabel(metric: ContributionMetric): string {
  return metric === "created"
    ? "pull requests created"
    : "merged pull requests";
}

/** Round tick values: 0, 20, 40 … rather than 0 / half / max. */
export function niceTicks(max: number): { top: number; ticks: number[] } {
  const raw = Math.max(1, max) / 5;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10]
      .map((m) => m * magnitude)
      .find((candidate) => candidate >= raw && Number.isInteger(candidate)) ??
    Math.ceil(raw);
  const top = Math.ceil(Math.max(1, max) / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top; value += step) ticks.push(value);
  return { top, ticks };
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function truncate(label: string): string {
  return label.length > LEGEND_MAX_CHARS
    ? `${label.slice(0, LEGEND_MAX_CHARS - 1)}…`
    : label;
}

function bucketLabel(date: string, interval: ShareInterval): string {
  const [, month, dom] = date.split("-");
  const name = MONTHS[Number(month) - 1]!;
  return interval === "month" ? name : `${name} ${dom}`;
}

/** Which buckets get an x label: the first, each new month, and the last. */
function xLabels(
  dates: readonly string[],
  interval: ShareInterval,
  slot: number
): { index: number; label: string; anchor: "start" | "middle" | "end" }[] {
  if (dates.length === 0) return [];
  if (interval === "month") {
    return dates.map((date, index) => ({
      index,
      label: bucketLabel(date, interval),
      anchor: "middle"
    }));
  }
  const last = dates.length - 1;
  // Keep labels ~60px apart, and clear of the right-anchored last label.
  const minGap = Math.ceil(60 / Math.max(slot, 0.001));
  const picked: { index: number; label: string; anchor: "start" | "end" }[] =
    [];
  dates.forEach((date, index) => {
    const newMonth =
      index === 0 || date.slice(0, 7) !== dates[index - 1]!.slice(0, 7);
    const previous = picked.at(-1)?.index ?? -Infinity;
    if (newMonth && index - previous >= minGap && last - index >= minGap) {
      picked.push({
        index,
        label: bucketLabel(date, interval),
        anchor: "start"
      });
    }
  });
  picked.push({
    index: last,
    label: bucketLabel(dates[last]!, interval),
    anchor: "end"
  });
  return picked;
}

export function shareImageSvg(
  chart: ContributionShareChart,
  {
    title,
    yLabel,
    interval,
    theme
  }: {
    title: string;
    yLabel: string;
    interval: ShareInterval;
    theme: ShareTheme;
  }
): string {
  const palette = PALETTES[theme];
  const width = SHARE_IMAGE_WIDTH;
  const height = SHARE_IMAGE_HEIGHT;
  const legend = chart.series.length > 1;
  const legendWidth = legend
    ? Math.min(
        200,
        26 +
          Math.max(...chart.series.map((s) => truncate(s.label).length)) * 6.6
      )
    : 0;
  const plot = {
    left: 62,
    top: 58,
    right: width - 22 - (legend ? legendWidth + 14 : 0),
    bottom: height - 38
  };
  const plotWidth = plot.right - plot.left;
  const plotHeight = plot.bottom - plot.top;
  const { top, ticks } = niceTicks(
    Math.max(0, ...chart.buckets.map((bucket) => bucket.total))
  );
  const slot = plotWidth / Math.max(1, chart.buckets.length);
  const gap = slot >= 4 ? 1 : 0;
  const y = (value: number) => plot.bottom - (value / top) * plotHeight;
  const text = (
    x: number,
    yPos: number,
    content: string,
    attrs: string
  ): string =>
    `<text x="${x.toFixed(1)}" y="${yPos.toFixed(1)}" ${attrs}>${escapeXml(content)}</text>`;

  const parts: string[] = [];
  parts.push(
    `<rect width="${width}" height="${height}" fill="${palette.background}"/>`,
    text(
      20,
      32,
      title,
      `font-size="15" font-weight="600" fill="${palette.title}"`
    ),
    `<text transform="translate(20 ${(plot.top + plotHeight / 2).toFixed(1)}) rotate(-90)" text-anchor="middle" font-size="11" fill="${palette.tick}">${escapeXml(yLabel)}</text>`
  );
  for (const tick of ticks) {
    parts.push(
      `<line x1="${plot.left}" x2="${plot.right}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}" stroke="${palette.grid}"/>`,
      text(
        plot.left - 8,
        y(tick) + 4,
        String(tick),
        `font-size="11" text-anchor="end" fill="${palette.tick}"`
      )
    );
  }
  chart.buckets.forEach((bucket, index) => {
    const x = plot.left + index * slot;
    let base = 0;
    bucket.values.forEach((value, seriesIndex) => {
      if (value <= 0) return;
      const series = chart.series[seriesIndex]!;
      parts.push(
        `<rect x="${x.toFixed(2)}" y="${y(base + value).toFixed(2)}" width="${Math.max(0.5, slot - gap).toFixed(2)}" height="${((value / top) * plotHeight).toFixed(2)}" fill="${shareColor(theme, seriesIndex, series.other === true)}"/>`
      );
      base += value;
    });
  });
  for (const label of xLabels(
    chart.buckets.map((bucket) => bucket.date),
    interval,
    slot
  )) {
    const x =
      label.anchor === "end"
        ? plot.left + (label.index + 1) * slot
        : label.anchor === "middle"
          ? plot.left + (label.index + 0.5) * slot
          : plot.left + label.index * slot;
    parts.push(
      text(
        x,
        plot.bottom + 18,
        label.label,
        `font-size="11" text-anchor="${label.anchor}" fill="${palette.tick}"`
      )
    );
  }
  if (legend) {
    const left = plot.right + 18;
    chart.series.forEach((series, index) => {
      const row = plot.top + index * 19;
      parts.push(
        `<rect x="${left}" y="${row}" width="11" height="11" rx="2" fill="${shareColor(theme, index, series.other === true)}"/>`,
        text(
          left + 18,
          row + 10,
          truncate(series.label),
          `font-size="12" fill="${palette.tick}"`
        )
      );
    });
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * SHARE_IMAGE_SCALE}" height="${height * SHARE_IMAGE_SCALE}" viewBox="0 0 ${width} ${height}" font-family='${FONT}'>`,
    ...parts,
    `</svg>`
  ].join("");
}

/** Draws the SVG through a canvas at the export scale. */
export async function shareImagePng(svg: string): Promise<Blob> {
  const url = URL.createObjectURL(
    new Blob([svg], { type: "image/svg+xml;charset=utf-8" })
  );
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = SHARE_IMAGE_WIDTH * SHARE_IMAGE_SCALE;
    canvas.height = SHARE_IMAGE_HEIGHT * SHARE_IMAGE_SCALE;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2d context");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob === null) reject(new Error("could not encode the image"));
        else resolve(blob);
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
