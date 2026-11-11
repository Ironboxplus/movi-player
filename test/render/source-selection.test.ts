import { describe, expect, it } from "vitest";
import {
  activeIdentity,
  autoQualityAllowed,
  buildSubtitleMenu,
  chooseOpeningSource,
  hiddenExternalLangs,
  identityOfExternal,
  qualityMenuMode,
  reconcileChildTracks,
  resolveIdentity,
  retargetTrack,
  trackEvents,
  type ExternalSubtitle,
  type InbandSlot,
  type InbandTrack,
} from "../../src/render/SourceSelection";

// The shape of a real 115 title: one original MKV with twelve embedded subrip
// tracks (小城良方 S01E28), and the cloud-transcode HLS rungs next to it. 115's
// own subtitle API lists only the first ten of those twelve.
const ORIGINAL = "https://host/d/movie.mkv";
const HLS_1080 = "https://host/hls/1080.m3u8#.m3u8";
const HLS_360 = "https://host/hls/360.m3u8#.m3u8";
const LADDER = [ORIGINAL, HLS_1080, HLS_360].map((src) => ({ src }));

const TITLES = [
  "印尼语",
  "法语",
  "泰语",
  "简体中文",
  "繁体中文",
  "英语",
  "葡萄牙语",
  "西班牙语",
  "越南语",
  "阿拉伯语",
  "韩语",
  "马来语",
];

const inband: InbandTrack[] = TITLES.map((title, i) => ({ id: 100 + i, title }));
const remembered: InbandSlot[] = TITLES.map((title, order) => ({ order, title }));

// What the 115 entries look like once the host has declared them as <track>.
const aliases: ExternalSubtitle[] = TITLES.slice(0, 10).map((title, order) => ({
  lang: `x${order}`,
  label: `[内置字幕]${title}`,
  active: false,
  inbandTitle: title,
  inbandOrder: order,
}));

describe("quality menu follows the <source> list, not the playing source", () => {
  it("is still the source menu while an HLS source is playing", () => {
    expect(
      qualityMenuMode({ currentSrc: HLS_1080, ladder: LADDER, dashRenditionCount: 3 }),
    ).toBe("sources");
  });

  it("is the source menu on the original too", () => {
    expect(
      qualityMenuMode({ currentSrc: ORIGINAL, ladder: LADDER, dashRenditionCount: 0 }),
    ).toBe("sources");
  });

  it("keeps the old behaviour with no source list", () => {
    expect(
      qualityMenuMode({ currentSrc: "a.mp4", ladder: [], dashRenditionCount: 0 }),
    ).toBe("none");
    expect(
      qualityMenuMode({ currentSrc: "a.m3u8", ladder: [], dashRenditionCount: 4 }),
    ).toBe("dash");
    expect(
      qualityMenuMode({ currentSrc: "a.m3u8", ladder: [], dashRenditionCount: 0 }),
    ).toBe("levels");
  });
});

describe("a mixed list has no Auto and opens on data-default", () => {
  it("offers no Auto when any source is HLS", () => {
    expect(autoQualityAllowed(LADDER)).toBe(false);
    expect(autoQualityAllowed([{ src: "a.mp4" }, { src: "b.mp4" }])).toBe(true);
  });

  it("ignores a stored Auto preference and the smallest rung", () => {
    expect(
      chooseOpeningSource({
        ladder: LADDER,
        declaredDefault: ORIGINAL,
        fallback: HLS_1080,
        autoPref: true,
        smallest: HLS_360,
      }),
    ).toBe(ORIGINAL);
  });

  it("still opens on the smallest rung of an all-file ladder under Auto", () => {
    const files = [{ src: "a1080.mp4" }, { src: "a240.mp4" }];
    expect(
      chooseOpeningSource({
        ladder: files,
        declaredDefault: "a1080.mp4",
        fallback: "a1080.mp4",
        autoPref: true,
        smallest: "a240.mp4",
      }),
    ).toBe("a240.mp4");
    expect(
      chooseOpeningSource({
        ladder: files,
        declaredDefault: "a1080.mp4",
        fallback: "a1080.mp4",
        autoPref: false,
        smallest: "a240.mp4",
      }),
    ).toBe("a1080.mp4");
  });
});

describe("subtitle aliases", () => {
  it("keeps an alias out of the menu when the source has its in-band track", () => {
    const entries = buildSubtitleMenu({ inband, external: aliases, activeMuxedId: null });
    expect(entries.map((e) => e.label)).toEqual(TITLES);
    expect(entries.every((e) => e.kind === "muxed")).toBe(true);
    expect(hiddenExternalLangs({ inband, external: aliases })).toEqual(
      new Set(aliases.map((a) => a.lang)),
    );
  });

  it("shows the alias under the original track's name when the source has none", () => {
    const entries = buildSubtitleMenu({
      inband: [],
      external: aliases,
      remembered,
      activeMuxedId: null,
    });
    const shown = entries.filter((e) => e.kind === "external");
    expect(shown.map((e) => e.label)).toEqual(TITLES.slice(0, 10));
    expect(shown.map((e) => (e.kind === "external" ? e.lang : ""))).toEqual(
      aliases.map((a) => a.lang),
    );
    expect(hiddenExternalLangs({ inband: [], external: aliases, remembered }).size).toBe(0);
  });

  it("treats an alias whose title disagrees as a plain external file", () => {
    const wrong: ExternalSubtitle[] = [
      { ...aliases[3], inbandTitle: "English", label: "[内置字幕]English" },
    ];
    // Original: the muxed track at that index is 简体中文, so this is NOT it.
    const onOriginal = buildSubtitleMenu({ inband, external: wrong, activeMuxedId: null });
    expect(onOriginal).toHaveLength(13);
    expect(onOriginal[12]).toMatchObject({
      kind: "external",
      label: "[内置字幕]English",
      identity: "ext:x3",
    });
    // HLS, with the original's list remembered: same verdict.
    const onHls = buildSubtitleMenu({
      inband: [],
      external: wrong,
      remembered,
      activeMuxedId: null,
    });
    expect(onHls.filter((e) => e.kind === "external")).toHaveLength(1);
    expect(onHls.find((e) => e.kind === "external")).toMatchObject({
      identity: "ext:x3",
      label: "[内置字幕]English",
    });
  });

  it("treats an alias past the end of the in-band list as plain", () => {
    const far: ExternalSubtitle[] = [
      { lang: "x", label: "L", active: false, inbandTitle: "法语", inbandOrder: 40 },
    ];
    const entries = buildSubtitleMenu({ inband, external: far, activeMuxedId: null });
    expect(entries.at(-1)).toMatchObject({ kind: "external", identity: "ext:x" });
  });

  it("greys out in-band tracks with no alias while a rendition is playing", () => {
    const entries = buildSubtitleMenu({
      inband: [],
      external: aliases,
      remembered,
      activeMuxedId: null,
    });
    const greyed = entries.filter((e) => e.kind === "original-only");
    expect(greyed.map((e) => e.label)).toEqual(["韩语", "马来语"]);
    // …in the original's order, after the ten that can be shown.
    expect(entries.map((e) => e.label)).toEqual(TITLES);
  });

  it("lists plain externals after the in-band slots", () => {
    const own: ExternalSubtitle = { lang: "own", label: "My file", active: false };
    const entries = buildSubtitleMenu({
      inband: [],
      external: [own, ...aliases],
      remembered,
      activeMuxedId: null,
    });
    expect(entries.at(-1)).toMatchObject({ kind: "external", lang: "own", identity: "ext:own" });
  });

  it("trusts an alias when the original was never opened", () => {
    const entries = buildSubtitleMenu({
      inband: [],
      external: aliases,
      activeMuxedId: null,
    });
    expect(entries.map((e) => e.label)).toEqual(TITLES.slice(0, 10));
  });

  it("matches titles regardless of case and padding", () => {
    const entries = buildSubtitleMenu({
      inband: [{ id: 1, title: " English " }],
      external: [
        { lang: "e", label: "x", active: false, inbandTitle: "english", inbandOrder: 0 },
      ],
      activeMuxedId: null,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("muxed");
  });
});

describe("the selection survives a source switch", () => {
  const original = { inband, external: aliases, remembered };
  const rendition = { inband: [] as InbandTrack[], external: aliases, remembered };

  it("keeps 繁体中文 across original -> 1080P -> original", () => {
    // On the original, 繁体中文 is the in-band track at index 4 (id 104).
    const before = { ...original, activeMuxedId: 104 };
    expect(activeIdentity(before)).toBe("inband:4");

    // On the rendition the same identity resolves to the extracted file.
    const hlsMenu = buildSubtitleMenu({ ...rendition, activeMuxedId: null });
    const onHls = resolveIdentity(hlsMenu, "inband:4");
    expect(onHls).toMatchObject({ kind: "external", lang: "x4", label: "繁体中文" });

    // The file is now what is showing; switching back resolves to the track.
    const externals = aliases.map((a) => ({ ...a, active: a.lang === "x4" }));
    expect(activeIdentity({ ...rendition, external: externals, activeMuxedId: null })).toBe(
      "inband:4",
    );
    const origMenu = buildSubtitleMenu({ ...original, activeMuxedId: null });
    expect(resolveIdentity(origMenu, "inband:4")).toMatchObject({ kind: "muxed", id: 104 });
  });

  it("names a hidden alias by its in-band identity", () => {
    expect(identityOfExternal(original, "x4")).toBe("inband:4");
    expect(identityOfExternal(original, "nope")).toBe("ext:nope");
  });

  it("carries a plain external file by its own identity", () => {
    const own: ExternalSubtitle = { lang: "own", label: "My file", active: true };
    const state = { inband: [] as InbandTrack[], external: [own, ...aliases], remembered };
    expect(activeIdentity({ ...state, activeMuxedId: null })).toBe("ext:own");
    const menu = buildSubtitleMenu({ ...state, activeMuxedId: null });
    expect(resolveIdentity(menu, "ext:own")).toMatchObject({ lang: "own" });
  });

  it("does not resolve to a greyed entry", () => {
    const menu = buildSubtitleMenu({ ...rendition, activeMuxedId: null });
    expect(resolveIdentity(menu, "inband:10")).toBeNull();
  });
});

// The twelve tracks of the file above, but the way 小城良方's 11th and 12th (and
// every track of many fansub rips) come: the container gave them no name, so
// the player invents "Subtitle <id>" and the host has no title to send.
describe("a track with no name is matched by order and language", () => {
  const LANGS = ["ind", "fre", "tha", "chi", "chi", "eng", "por", "spa", "vie", "ara", "kor", "may"];
  const unnamedInband: InbandTrack[] = LANGS.map((lang, i) => ({
    id: 200 + i,
    title: `Subtitle ${200 + i}`,
    lang,
    untitled: true,
  }));
  const unnamedRemembered: InbandSlot[] = unnamedInband.map((t, order) => ({
    order,
    title: t.title,
    lang: t.lang,
    untitled: true,
  }));
  const unnamedTwin = (order: number, lang: string): ExternalSubtitle => ({
    lang: `x${order}`,
    label: `Subtitle ${order + 1}`,
    active: false,
    inbandOrder: order,
    inbandLang: lang,
  });

  it("confirms an alias with no title against an unnamed original track", () => {
    const external = [unnamedTwin(10, "kor"), unnamedTwin(11, "may")];
    const entries = buildSubtitleMenu({
      inband: [],
      external,
      remembered: unnamedRemembered,
      activeMuxedId: null,
    });
    expect(entries.filter((e) => e.kind === "external").map((e) => e.identity)).toEqual([
      "inband:10",
      "inband:11",
    ]);
    // …so neither of those two is left greyed (the ten with no file are)
    const greyed = entries.filter((e) => e.kind === "original-only").map((e) => e.identity)
    expect(greyed).not.toContain("inband:10")
    expect(greyed).not.toContain("inband:11")
    expect(greyed).toHaveLength(10);
    // and on the original the twin steps aside for the track itself
    expect(hiddenExternalLangs({ inband: unnamedInband, external })).toEqual(
      new Set(["x10", "x11"]),
    );
  });

  it("accepts the languages 639-1 and 639-2 spell differently as one", () => {
    const entries = buildSubtitleMenu({
      inband: [],
      external: [unnamedTwin(3, "zh"), unnamedTwin(10, "ko-KR")],
      remembered: unnamedRemembered,
      activeMuxedId: null,
    });
    expect(entries.filter((e) => e.kind === "external")).toHaveLength(2);
  });

  it("rejects an alias whose language is not the track's", () => {
    const entries = buildSubtitleMenu({
      inband: [],
      external: [unnamedTwin(10, "jpn")],
      remembered: unnamedRemembered,
      activeMuxedId: null,
    });
    expect(entries.find((e) => e.identity === "inband:10")?.kind).toBe("original-only");
    expect(entries.find((e) => e.identity === "ext:x10")).toMatchObject({ kind: "external" });
  });

  it("uses the language when only one side has a title", () => {
    // The host knows the name, the container does not
    const named: ExternalSubtitle = { ...unnamedTwin(10, "kor"), inbandTitle: "韩语" };
    expect(
      buildSubtitleMenu({ inband: [], external: [named], remembered: unnamedRemembered, activeMuxedId: null })
        .find((e) => e.identity === "inband:10")?.kind,
    ).toBe("external");
    // …and the other way round
    const original = [{ id: 1, title: "韩语", lang: "kor" }];
    expect(
      buildSubtitleMenu({ inband: original, external: [unnamedTwin(0, "kor")], activeMuxedId: null })
        .map((e) => e.kind),
    ).toEqual(["muxed"]);
    expect(
      buildSubtitleMenu({ inband: original, external: [unnamedTwin(0, "eng")], activeMuxedId: null })
        .map((e) => e.kind),
    ).toEqual(["muxed", "external"]);
  });

  it("does not let a code that says nothing disagree", () => {
    const entries = buildSubtitleMenu({
      inband: [],
      external: [unnamedTwin(10, "")],
      remembered: [{ order: 10, title: "Subtitle 1", lang: "und", untitled: true }],
      activeMuxedId: null,
    });
    expect(entries.find((e) => e.identity === "inband:10")?.kind).toBe("external");
  });

  it("labels the row with the file's own label when the track has no name", () => {
    const entries = buildSubtitleMenu({
      inband: [],
      external: [unnamedTwin(10, "kor")],
      remembered: unnamedRemembered,
      activeMuxedId: null,
    });
    expect(entries.find((e) => e.identity === "inband:10")).toMatchObject({ label: "Subtitle 11" });
  });
});

describe("a subtitle that is still being made is a row like any other", () => {
  const remembered2: InbandSlot[] = [{ order: 0, title: "English", lang: "eng" }];
  const pendingTwin: ExternalSubtitle = {
    lang: "x0",
    label: "English",
    active: false,
    pending: true,
    inbandTitle: "English",
    inbandOrder: 0,
  };

  it("is offered with its working indicator, not greyed", () => {
    const entries = buildSubtitleMenu({
      inband: [],
      external: [pendingTwin],
      remembered: remembered2,
      activeMuxedId: null,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "external", pending: true, identity: "inband:0" });
  });

  it("can be the target of a selection carried across a source switch", () => {
    const entries = buildSubtitleMenu({
      inband: [],
      external: [pendingTwin],
      remembered: remembered2,
      activeMuxedId: null,
    });
    expect(resolveIdentity(entries, "inband:0")).toMatchObject({ kind: "external", lang: "x0" });
  });
});

describe("a <track> whose src is rewritten loads again", () => {
  const tracks = () => [
    { lang: "x0", src: "/api/fs/subtitle_extract?track=0&at=10", label: "a" },
    { lang: "x1", src: "/api/fs/subtitle_extract?track=1&at=10", label: "b" },
  ];

  it("takes the new src for the same track and says which one to reload", () => {
    const list = tracks();
    const hit = retargetTrack(list, "x0", "/api/fs/subtitle_extract?track=0&at=10&rev=1");
    expect(hit).toBe(list[0]);
    expect(list[0].src).toMatch(/rev=1$/);
    expect(list[1].src).toMatch(/track=1&at=10$/);
  });

  it("does nothing for the same src, an empty one, or an unknown track", () => {
    const list = tracks();
    expect(retargetTrack(list, "x0", list[0].src)).toBeNull();
    expect(retargetTrack(list, "x0", "")).toBeNull();
    expect(retargetTrack(list, "nope", "/x")).toBeNull();
    expect(list).toEqual(tracks());
  });
});

// WHATWG HTML, "When a track element's parent element changes and the new
// parent is a media element, then the user agent must add the track element's
// corresponding text track ... and fire addtrack": a <track> that arrives after
// the element was set up joins the subtitle list, and one that leaves, leaves.
describe("a <track> added or removed after the element was set up", () => {
  type Declared = {
    src: string;
    lang: string;
    label: string;
    inbandTitle?: string;
    inbandOrder?: number;
  };
  const declared = (order: number): Declared => ({
    src: `/api/fs/subtitle_extract?track=${order}`,
    lang: `sub${order}`,
    label: `[内置字幕]${TITLES[order]}`,
    inbandTitle: TITLES[order],
    inbandOrder: order,
  });
  const asExternal = (ts: Declared[]): ExternalSubtitle[] =>
    ts.map((t) => ({ ...t, active: false }));
  const late = [declared(10), declared(11)]; // 韩语, 马来语

  it("reports the new track as added, the held ones untouched", () => {
    const held = [declared(0)];
    const change = reconcileChildTracks(held, ["sub0"], [declared(0), ...late]);
    expect(change.added.map((t) => t.lang)).toEqual(["sub10", "sub11"]);
    expect(change.removed).toEqual([]);
  });

  it("reports a track that left the children as removed", () => {
    const held = [declared(0), ...late];
    const change = reconcileChildTracks(
      held,
      ["sub0", "sub10", "sub11"],
      [declared(0), declared(10)],
    );
    expect(change.added).toEqual([]);
    expect(change.removed.map((t) => t.lang)).toEqual(["sub11"]);
  });

  it("does not touch a track the host passed in JS rather than as a child", () => {
    const js = { src: "blob:x", lang: "file-1", label: "mine" };
    const change = reconcileChildTracks([js], [], [declared(10)]);
    expect(change.removed).toEqual([]);
    expect(change.added.map((t) => t.lang)).toEqual(["sub10"]);
  });

  it("says addtrack for each track added and removetrack for each removed", () => {
    const held = [declared(0), declared(1)];
    const change = reconcileChildTracks(
      held,
      ["sub0", "sub1"],
      [declared(0), ...late],
    );
    expect(trackEvents(change).map((e) => [e.type, e.track.lang])).toEqual([
      ["removetrack", "sub1"],
      ["addtrack", "sub10"],
      ["addtrack", "sub11"],
    ]);
  });

  it("reports nothing when the children are what the element already holds", () => {
    const held = [declared(0), declared(1)];
    expect(
      reconcileChildTracks(held, ["sub0", "sub1"], [declared(0), declared(1)]),
    ).toEqual({ added: [], removed: [] });
  });

  it("puts the late track in the menu: HLS shows it under the in-band name", () => {
    const menu = buildSubtitleMenu({
      inband: [],
      external: asExternal(late),
      remembered,
      activeMuxedId: null,
    });
    const shown = menu.filter((e) => e.kind === "external");
    expect(shown.map((e) => e.label)).toEqual(["韩语", "马来语"]);
    expect(shown.map((e) => e.identity)).toEqual(["inband:10", "inband:11"]);
    expect(menu.some((e) => e.kind === "original-only" && e.label === "韩语")).toBe(
      false,
    );
  });

  it("puts the late track in the menu: on the original the in-band track stands in", () => {
    const input = {
      inband,
      external: asExternal(late),
      remembered,
      activeMuxedId: null,
    };
    expect([...hiddenExternalLangs(input)]).toEqual(["sub10", "sub11"]);
    const menu = buildSubtitleMenu(input);
    expect(menu.filter((e) => e.kind === "external")).toEqual([]);
    expect(menu.map((e) => e.label)).toContain("韩语");
  });

  it("takes the track out of the menu again when it is removed", () => {
    const held = [declared(10), declared(11)];
    const change = reconcileChildTracks(held, ["sub10", "sub11"], [declared(10)]);
    const left = held.filter((t) => !change.removed.includes(t));
    const menu = buildSubtitleMenu({
      inband: [],
      external: asExternal(left),
      remembered: undefined,
      activeMuxedId: null,
    });
    expect(menu.map((e) => e.label)).toEqual(["韩语"]);
  });
});
