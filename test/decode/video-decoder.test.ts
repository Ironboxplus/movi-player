import { afterEach, describe, expect, it, vi } from "vitest";
import { MoviVideoDecoder } from "../../src/decode/VideoDecoder";
import type { VideoTrack } from "../../src/types";
import type { WasmBindings } from "../../src/wasm/bindings";

const mpeg2Track: VideoTrack = {
  id: 0,
  type: "video",
  codec: "mpeg2video",
  width: 1920,
  height: 1080,
  frameRate: 23.976,
  bitRate: 0,
  profile: 4,
  level: 4,
  pixelFormat: "yuv420p",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MoviVideoDecoder software fallback", () => {
  it("uses FFmpeg WASM when a codec has no WebCodecs mapping", async () => {
    vi.stubGlobal("window", { VideoDecoder: class {} });

    const bindings = {
      enableDecoder: vi.fn(() => 0),
      setSkipFrame: vi.fn(),
    } as unknown as WasmBindings;
    const decoder = new MoviVideoDecoder();
    decoder.setBindings(bindings);

    await expect(decoder.configure(mpeg2Track)).resolves.toBe(true);

    expect(bindings.enableDecoder).toHaveBeenCalledWith(mpeg2Track.id);
    expect(bindings.setSkipFrame).toHaveBeenCalledWith(mpeg2Track.id, 0);
    expect(decoder.isSoftware).toBe(true);
    expect(decoder.getStats().decoderType).toBe("Software (FFmpeg)");
  });
});
