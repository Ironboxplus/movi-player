import { afterEach, describe, expect, it, vi } from "vitest";
import { SoftwareVideoDecoder } from "../../src/decode/SoftwareVideoDecoder";
import type { WasmBindings } from "../../src/wasm/bindings";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeBindings(nativeFormat: VideoPixelFormat = "I420") {
  const nativeData = new Uint8Array(12);
  const rgbaData = new Uint8Array(32);
  const bindings = {
    getFrameWidth: vi.fn(() => 4),
    getFrameHeight: vi.fn(() => 2),
    getFrameWebCodecsBuffer: vi.fn(() => ({
      format: nativeFormat,
      data: nativeData,
      layout: [
        { offset: 0, stride: 4 },
        { offset: 8, stride: 2 },
        { offset: 10, stride: 2 },
      ],
    })),
    getFrameRGBA: vi.fn(() => rgbaData),
  } as unknown as WasmBindings;

  return { bindings, nativeData, rgbaData };
}

function processOneFrame(decoder: SoftwareVideoDecoder, timestamp = 1_000_000) {
  (
    decoder as unknown as { processDecodedFrame(value: number): void }
  ).processDecodedFrame(timestamp);
}

describe("SoftwareVideoDecoder decoded-frame output", () => {
  it("passes supported native planes directly to VideoFrame without RGBA conversion", () => {
    const created: Array<{ data: Uint8Array; init: VideoFrameBufferInit }> = [];
    vi.stubGlobal(
      "VideoFrame",
      class {
        constructor(data: Uint8Array, init: VideoFrameBufferInit) {
          created.push({ data, init });
        }
      },
    );

    const { bindings, nativeData } = makeBindings();
    const decoder = new SoftwareVideoDecoder(bindings);
    const onFrame = vi.fn();
    decoder.setOnFrame(onFrame);

    processOneFrame(decoder);

    expect(created).toHaveLength(1);
    expect(created[0].data).toBe(nativeData);
    expect(created[0].init.format).toBe("I420");
    expect(bindings.getFrameRGBA).not.toHaveBeenCalled();
    expect(onFrame).toHaveBeenCalledOnce();
  });

  it("falls back to RGBA when the browser rejects the native pixel format", () => {
    const created: Array<{ data: Uint8Array; init: VideoFrameBufferInit }> = [];
    vi.stubGlobal(
      "VideoFrame",
      class {
        constructor(data: Uint8Array, init: VideoFrameBufferInit) {
          if (init.format !== "RGBA") {
            throw new TypeError(
              `Unsupported VideoFrame format: ${init.format}`,
            );
          }
          created.push({ data, init });
        }
      },
    );

    const { bindings, rgbaData } = makeBindings();
    const decoder = new SoftwareVideoDecoder(bindings);
    const onFrame = vi.fn();
    const onError = vi.fn();
    decoder.setOnFrame(onFrame);
    decoder.setOnError(onError);

    processOneFrame(decoder);

    expect(bindings.getFrameRGBA).toHaveBeenCalledWith(4, 2);
    expect(created).toHaveLength(1);
    expect(created[0].data).toBe(rgbaData);
    expect(created[0].init.format).toBe("RGBA");
    expect(onFrame).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });
});
