import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeUtf8 } from "../../src/wasm/bindings";

// Chrome's TextDecoder.decode() rejects views backed by a resizable/growable
// ArrayBuffer — exactly what Emscripten's heap becomes with newer emsdk
// runtimes (Memory.toResizableBuffer()). Node's TextDecoder does NOT enforce
// this, so these tests can't just assert "doesn't throw"; instead they assert
// the invariant Chrome enforces: the bytes handed to TextDecoder.decode must
// never be backed by a resizable buffer.

/** Build a Uint8Array heap over a RESIZABLE ArrayBuffer, like the WASM heap. */
function resizableHeap(bytes: number[]): Uint8Array {
  const ab = new ArrayBuffer(Math.max(bytes.length, 16), {
    maxByteLength: 1 << 16,
  });
  expect(ab.resizable).toBe(true); // sanity: environment supports this
  const heap = new Uint8Array(ab);
  heap.set(bytes);
  return heap;
}

const utf8 = (s: string) => [...new TextEncoder().encode(s)];

afterEach(() => vi.restoreAllMocks());

describe("decodeUtf8 (WASM heap string reads)", () => {
  it("decodes ASCII from a view over a resizable buffer", () => {
    const heap = resizableHeap(utf8("h264"));
    expect(decodeUtf8(heap.subarray(0, 4))).toBe("h264");
  });

  it("decodes multi-byte CJK correctly (copy must not split bytes)", () => {
    const bytes = utf8("回忆三部曲");
    const heap = resizableHeap(bytes);
    expect(decodeUtf8(heap.subarray(0, bytes.length))).toBe("回忆三部曲");
  });

  it("decodes an interior window of the heap (non-zero byteOffset)", () => {
    const heap = resizableHeap([0, 0, ...utf8("dts"), 0, 0]);
    expect(decodeUtf8(heap.subarray(2, 5))).toBe("dts");
  });

  it("never hands TextDecoder a view backed by a resizable buffer", () => {
    const seen: Array<boolean | undefined> = [];
    const original = TextDecoder.prototype.decode;
    vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (
      this: TextDecoder,
      input?: AllowSharedBufferSource,
    ) {
      const buf =
        input instanceof Uint8Array ? input.buffer : (input as ArrayBuffer);
      seen.push((buf as ArrayBuffer).resizable);
      return original.call(this, input);
    });

    const heap = resizableHeap(utf8("truehd"));
    const out = decodeUtf8(heap.subarray(0, 6));

    expect(out).toBe("truehd");
    expect(seen.length).toBeGreaterThan(0);
    // The invariant Chrome enforces: every buffer reaching decode() is fixed.
    expect(seen).not.toContain(true);
  });

  it("result survives heap growth (no live view into WASM memory)", () => {
    const heap = resizableHeap(utf8("eac3"));
    const view = heap.subarray(0, 4);
    const out = decodeUtf8(view);
    (heap.buffer as ArrayBuffer).resize(1 << 12); // simulates _malloc growth
    expect(out).toBe("eac3");
  });
});

describe("bindings.ts TextDecoder usage (regression guard)", () => {
  it("routes every heap string read through decodeUtf8", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/wasm/bindings.ts", import.meta.url)),
      "utf-8",
    );
    // Exactly one TextDecoder construction: the one inside decodeUtf8.
    const uses = src.match(/new TextDecoder\(/g) ?? [];
    expect(uses).toHaveLength(1);
  });
});
