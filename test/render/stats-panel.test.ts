import { describe, expect, it } from "vitest";
import { groupStats, renderStatsPanel } from "../../src/render/StatsPanel";

describe("stats panel renderer", () => {
  it("groups mpv-style playback, audio, video, and io stats into sections", () => {
    const sections = groupStats({
      "Playback State": "playing",
      "Seek Waiting For Video": "No",
      "Seek Audio Hold Packets": 0,
      "Seek Audio Dropped Packets": 12,
      "Pause Prebuffer Packets": 0,
      "Video Decoder": "Hardware (WebCodecs)",
      "Audio Decoder": "Software (FFmpeg Worker)",
      "Audio Worker In Flight": 3,
      "Audio Worker Reorder Backlog": 1,
      "Network Speed": "8.0 MB/s",
    });

    expect(sections.map((section) => section.title)).toEqual([
      "Playback",
      "Video",
      "Audio",
      "I/O",
    ]);
    expect(sections[2]?.rows.map((row) => row.key)).toContain(
      "Audio Worker In Flight",
    );
    expect(sections[2]?.rows.map((row) => row.key)).toContain(
      "Audio Worker Reorder Backlog",
    );
    expect(sections[0]?.rows.map((row) => row.key)).toEqual([
      "Playback State",
      "Seek Waiting For Video",
      "Seek Audio Hold Packets",
      "Seek Audio Dropped Packets",
      "Pause Prebuffer Packets",
    ]);
  });

  it("escapes dynamic stat values before rendering html", () => {
    const html = renderStatsPanel(
      {
        "Audio Codec": "<img src=x onerror=alert(1)>",
        "Audio Worker Stale Drops": 2,
      },
      { label: "Network <Activity>", speedText: "1 & 2 MB/s" },
    );

    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("Network &lt;Activity&gt;");
    expect(html).toContain("1 &amp; 2 MB/s");
    expect(html).not.toContain("<img src=x");
  });

  it("keeps unknown stats visible in an other section", () => {
    const sections = groupStats({ "Custom Probe": "present" });

    expect(sections).toEqual([
      {
        title: "Other",
        rows: [{ key: "Custom Probe", value: "present" }],
      },
    ]);
  });
});
