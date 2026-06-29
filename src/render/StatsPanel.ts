export type StatsValue = string | number | boolean;
export type StatsRecord = Record<string, StatsValue>;

export interface StatsGraphView {
  label: string;
  speedText: string;
}

interface StatsSectionSpec {
  title: string;
  keys: string[];
}

export interface StatsRow {
  key: string;
  value: StatsValue;
}

export interface StatsSection {
  title: string;
  rows: StatsRow[];
}

const SECTIONS: StatsSectionSpec[] = [
  {
    title: "Playback",
    keys: [
      "Playback State",
      "Playback Rate",
      "A/V Sync",
      "Stable Volume",
      "Decode Path",
      "Audio Buffer",
      "Audio Buffered Seconds",
      "Audio Underrun Risk",
    ],
  },
  {
    title: "Video",
    keys: [
      "Video Codec",
      "Video Decoder",
      "Resolution",
      "Quality",
      "Frame Rate",
      "Video Bitrate",
      "Pixel Format",
      "Color Space",
      "Color Range",
      "Color Primaries",
      "Color Transfer",
      "HDR",
      "Rotation",
      "Video Queue",
      "Video Decoder Queue",
      "Frames Rendered",
    ],
  },
  {
    title: "Audio",
    keys: [
      "Audio Codec",
      "Audio Decoder",
      "Language",
      "Sample Rate",
      "Channels",
      "Audio Bitrate",
      "Audio Decoder Queue",
      "Audio Software Fallback Reason",
      "Audio Worker Generation",
      "Audio Worker Track",
      "Audio Worker Queue Depth",
      "Audio Worker In Flight",
      "Audio Worker Reorder Backlog",
      "Audio Worker Stale Drops",
      "Audio Worker Configure State",
      "Audio Worker Configure ms",
      "Audio Worker Configure Timeout ms",
      "Audio Worker Last Error",
    ],
  },
  { title: "Subtitles", keys: ["Subtitle"] },
  { title: "Container", keys: ["Container", "Total Bitrate", "File Size"] },
  {
    title: "I/O",
    keys: [
      "Downloaded",
      "Network Speed",
      "Connection Time",
      "Disk Read",
      "Read Speed",
    ],
  },
  { title: "System", keys: ["Memory Used", "Memory Limit"] },
];

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function groupStats(stats: StatsRecord): StatsSection[] {
  const consumed = new Set<string>();
  const sections: StatsSection[] = [];

  for (const spec of SECTIONS) {
    const rows: StatsRow[] = [];
    for (const key of spec.keys) {
      if (!(key in stats)) continue;
      rows.push({ key, value: stats[key]! });
      consumed.add(key);
    }
    if (rows.length > 0) sections.push({ title: spec.title, rows });
  }

  const otherRows = Object.entries(stats)
    .filter(([key]) => !consumed.has(key))
    .map(([key, value]) => ({ key, value }));
  if (otherRows.length > 0) sections.push({ title: "Other", rows: otherRows });

  return sections;
}

export function renderStatsPanel(
  stats: StatsRecord,
  graph: StatsGraphView,
): string {
  const sections = groupStats(stats)
    .map((section) => {
      const rows = section.rows
        .map(
          (row) => `<div class="movi-nerd-stats-row">
        <span class="movi-nerd-stats-key">${escapeHtml(row.key)}</span>
        <span class="movi-nerd-stats-value">${escapeHtml(row.value)}</span>
      </div>`,
        )
        .join("");

      return `<section class="movi-nerd-stats-section">
      <div class="movi-nerd-stats-section-title">${escapeHtml(section.title)}</div>
      ${rows}
    </section>`;
    })
    .join("");

  return `${sections}<div class="movi-nerd-stats-graph-section">
      <div class="movi-nerd-stats-graph-header">
        <span class="movi-nerd-stats-graph-title">${escapeHtml(graph.label)}</span>
        <span class="movi-nerd-stats-graph-speed">${escapeHtml(graph.speedText)}</span>
      </div>
      <canvas class="movi-nerd-stats-graph" width="300" height="80"></canvas>
    </div>`;
}
