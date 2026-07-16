import { describe, expect, it } from "vitest";
import { WasmBindings } from "../../src/wasm/bindings";

type FormatCase = {
  id: number;
  format: string;
  planes: Array<{ rowWidth: number; rows: number }>;
};

const width = 4;
const height = 2;
const formats: FormatCase[] = [
  {
    id: 1,
    format: "I420",
    planes: [
      { rowWidth: 4, rows: 2 },
      { rowWidth: 2, rows: 1 },
      { rowWidth: 2, rows: 1 },
    ],
  },
  {
    id: 2,
    format: "I420P10",
    planes: [
      { rowWidth: 8, rows: 2 },
      { rowWidth: 4, rows: 1 },
      { rowWidth: 4, rows: 1 },
    ],
  },
  {
    id: 3,
    format: "I420P12",
    planes: [
      { rowWidth: 8, rows: 2 },
      { rowWidth: 4, rows: 1 },
      { rowWidth: 4, rows: 1 },
    ],
  },
  {
    id: 4,
    format: "I420A",
    planes: [
      { rowWidth: 4, rows: 2 },
      { rowWidth: 2, rows: 1 },
      { rowWidth: 2, rows: 1 },
      { rowWidth: 4, rows: 2 },
    ],
  },
  {
    id: 5,
    format: "I420AP10",
    planes: [
      { rowWidth: 8, rows: 2 },
      { rowWidth: 4, rows: 1 },
      { rowWidth: 4, rows: 1 },
      { rowWidth: 8, rows: 2 },
    ],
  },
  {
    id: 6,
    format: "I422",
    planes: [
      { rowWidth: 4, rows: 2 },
      { rowWidth: 2, rows: 2 },
      { rowWidth: 2, rows: 2 },
    ],
  },
  {
    id: 7,
    format: "I422P10",
    planes: [
      { rowWidth: 8, rows: 2 },
      { rowWidth: 4, rows: 2 },
      { rowWidth: 4, rows: 2 },
    ],
  },
  {
    id: 8,
    format: "I422P12",
    planes: [
      { rowWidth: 8, rows: 2 },
      { rowWidth: 4, rows: 2 },
      { rowWidth: 4, rows: 2 },
    ],
  },
  {
    id: 9,
    format: "I422A",
    planes: [
      { rowWidth: 4, rows: 2 },
      { rowWidth: 2, rows: 2 },
      { rowWidth: 2, rows: 2 },
      { rowWidth: 4, rows: 2 },
    ],
  },
  {
    id: 10,
    format: "I422AP10",
    planes: [
      { rowWidth: 8, rows: 2 },
      { rowWidth: 4, rows: 2 },
      { rowWidth: 4, rows: 2 },
      { rowWidth: 8, rows: 2 },
    ],
  },
  {
    id: 11,
    format: "I444",
    planes: [
      { rowWidth: 4, rows: 2 },
      { rowWidth: 4, rows: 2 },
      { rowWidth: 4, rows: 2 },
    ],
  },
  {
    id: 12,
    format: "I444P10",
    planes: [
      { rowWidth: 8, rows: 2 },
      { rowWidth: 8, rows: 2 },
      { rowWidth: 8, rows: 2 },
    ],
  },
  {
    id: 13,
    format: "I444P12",
    planes: [
      { rowWidth: 8, rows: 2 },
      { rowWidth: 8, rows: 2 },
      { rowWidth: 8, rows: 2 },
    ],
  },
  {
    id: 14,
    format: "I444A",
    planes: [
      { rowWidth: 4, rows: 2 },
      { rowWidth: 4, rows: 2 },
      { rowWidth: 4, rows: 2 },
      { rowWidth: 4, rows: 2 },
    ],
  },
  {
    id: 15,
    format: "I444AP10",
    planes: [
      { rowWidth: 8, rows: 2 },
      { rowWidth: 8, rows: 2 },
      { rowWidth: 8, rows: 2 },
      { rowWidth: 8, rows: 2 },
    ],
  },
  {
    id: 16,
    format: "NV12",
    planes: [
      { rowWidth: 4, rows: 2 },
      { rowWidth: 4, rows: 1 },
    ],
  },
  { id: 17, format: "RGBA", planes: [{ rowWidth: 16, rows: 2 }] },
  { id: 18, format: "RGBX", planes: [{ rowWidth: 16, rows: 2 }] },
  { id: 19, format: "BGRA", planes: [{ rowWidth: 16, rows: 2 }] },
  { id: 20, format: "BGRX", planes: [{ rowWidth: 16, rows: 2 }] },
];

function makeBindings(testCase: FormatCase) {
  const heap = new Uint8Array(4096);
  const pointers: number[] = [];
  const strides: number[] = [];
  const expected: number[] = [];
  let pointer = 64;

  testCase.planes.forEach((plane, planeIndex) => {
    const stride = plane.rowWidth + 3;
    pointers.push(pointer);
    strides.push(stride);
    for (let row = 0; row < plane.rows; row++) {
      for (let column = 0; column < plane.rowWidth; column++) {
        const value = 1 + planeIndex * 50 + row * 20 + column;
        heap[pointer + row * stride + column] = value;
        expected.push(value);
      }
      heap.fill(
        255,
        pointer + row * stride + plane.rowWidth,
        pointer + (row + 1) * stride,
      );
    }
    pointer += stride * plane.rows + 16;
  });

  const module = {
    HEAPU8: heap,
    _movi_get_frame_webcodecs_format: () => testCase.id,
    _movi_get_frame_data: (_context: number, plane: number) =>
      pointers[plane] ?? 0,
    _movi_get_frame_linesize: (_context: number, plane: number) =>
      strides[plane] ?? 0,
  };
  const bindings = Object.create(WasmBindings.prototype) as WasmBindings;
  Object.assign(bindings as object, { module, contextPtr: 1 });
  return { bindings, expected };
}

describe("WasmBindings WebCodecs frame packing", () => {
  for (const testCase of formats) {
    it(`packs ${testCase.format} without stride padding`, () => {
      const { bindings, expected } = makeBindings(testCase);
      const result = bindings.getFrameWebCodecsBuffer(width, height);

      expect(result?.format).toBe(testCase.format);
      expect(Array.from(result?.data ?? [])).toEqual(expected);
      expect(result?.layout.map((plane) => plane.stride)).toEqual(
        testCase.planes.map((plane) => plane.rowWidth),
      );
      expect(result?.data).not.toContain(255);
    });
  }

  it("returns null for a pixel format without a WebCodecs representation", () => {
    const unsupported = { id: 0, format: "unsupported", planes: [] };
    const { bindings } = makeBindings(unsupported);
    expect(bindings.getFrameWebCodecsBuffer(width, height)).toBeNull();
  });
});
