export interface PackedVideoFrame {
  format: VideoPixelFormat;
  data: Uint8Array;
  layout: PlaneLayout[];
}

type PlaneSpec = { width: number; height: number; bytes: number };

export function packWebCodecsFrame(
  heap: Uint8Array,
  formatId: number,
  width: number,
  height: number,
  getPlanePointer: (plane: number) => number,
  getPlaneStride: (plane: number) => number,
): PackedVideoFrame | null {
  if (width <= 0 || height <= 0) return null;

  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  let format: VideoPixelFormat;
  let planes: PlaneSpec[];

  switch (formatId) {
    case 1:
      format = "I420";
      planes = planar420(width, height, chromaWidth, chromaHeight, 1);
      break;
    case 2:
      format = "I420P10" as VideoPixelFormat;
      planes = planar420(width, height, chromaWidth, chromaHeight, 2);
      break;
    case 3:
      format = "I420P12" as VideoPixelFormat;
      planes = planar420(width, height, chromaWidth, chromaHeight, 2);
      break;
    case 4:
    case 5: {
      format = (formatId === 4 ? "I420A" : "I420AP10") as VideoPixelFormat;
      const bytes = formatId === 4 ? 1 : 2;
      planes = [
        ...planar420(width, height, chromaWidth, chromaHeight, bytes),
        { width, height, bytes },
      ];
      break;
    }
    case 6:
    case 7:
    case 8:
    case 9:
    case 10: {
      const names = ["", "I422", "I422P10", "I422P12", "I422A", "I422AP10"];
      format = names[formatId - 5] as VideoPixelFormat;
      const bytes = formatId === 6 || formatId === 9 ? 1 : 2;
      planes = [
        { width, height, bytes },
        { width: chromaWidth, height, bytes },
        { width: chromaWidth, height, bytes },
      ];
      if (formatId >= 9) planes.push({ width, height, bytes });
      break;
    }
    case 11:
    case 12:
    case 13:
    case 14:
    case 15: {
      const names = ["", "I444", "I444P10", "I444P12", "I444A", "I444AP10"];
      format = names[formatId - 10] as VideoPixelFormat;
      const bytes = formatId === 11 || formatId === 14 ? 1 : 2;
      planes = [
        { width, height, bytes },
        { width, height, bytes },
        { width, height, bytes },
      ];
      if (formatId >= 14) planes.push({ width, height, bytes });
      break;
    }
    case 16:
      format = "NV12";
      planes = [
        { width, height, bytes: 1 },
        { width: chromaWidth * 2, height: chromaHeight, bytes: 1 },
      ];
      break;
    case 17:
    case 18:
    case 19:
    case 20:
      format = ["", "RGBA", "RGBX", "BGRA", "BGRX"][
        formatId - 16
      ] as VideoPixelFormat;
      planes = [{ width, height, bytes: 4 }];
      break;
    default:
      return null;
  }

  const offsets: number[] = [];
  let totalSize = 0;
  for (const plane of planes) {
    offsets.push(totalSize);
    totalSize += plane.width * plane.bytes * plane.height;
  }
  const data = new Uint8Array(totalSize);

  for (let planeIndex = 0; planeIndex < planes.length; planeIndex++) {
    const plane = planes[planeIndex];
    const rowWidth = plane.width * plane.bytes;
    const srcPtr = getPlanePointer(planeIndex);
    const srcStride = getPlaneStride(planeIndex);
    if (!srcPtr || Math.abs(srcStride) < rowWidth) return null;

    for (let row = 0; row < plane.height; row++) {
      const srcStart = srcPtr + row * srcStride;
      if (srcStart < 0 || srcStart + rowWidth > heap.byteLength) return null;
      data.set(
        heap.subarray(srcStart, srcStart + rowWidth),
        offsets[planeIndex] + row * rowWidth,
      );
    }
  }

  return {
    format,
    data,
    layout: planes.map((plane, index) => ({
      offset: offsets[index],
      stride: plane.width * plane.bytes,
    })),
  };
}

function planar420(
  width: number,
  height: number,
  chromaWidth: number,
  chromaHeight: number,
  bytes: number,
): PlaneSpec[] {
  return [
    { width, height, bytes },
    { width: chromaWidth, height: chromaHeight, bytes },
    { width: chromaWidth, height: chromaHeight, bytes },
  ];
}
