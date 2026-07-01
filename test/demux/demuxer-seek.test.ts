import { describe, expect, it, vi } from "vitest";
import { Demuxer } from "../../src/demux/Demuxer";

function createOpenedDemuxer() {
  const demuxer = Object.create(Demuxer.prototype) as Demuxer & {
    bindings: { seek: ReturnType<typeof vi.fn> };
    isOpened: boolean;
  };
  demuxer.bindings = {
    seek: vi.fn().mockResolvedValue(undefined),
  };
  demuxer.isOpened = true;
  return demuxer;
}

describe("Demuxer.seek", () => {
  it("passes the requested stream index through to the WASM binding", async () => {
    const demuxer = createOpenedDemuxer();

    await demuxer.seek(306.882, 1, 3);

    expect(demuxer.bindings.seek).toHaveBeenCalledWith(306.882, 3, 1);
  });

  it("keeps global seek as the default for callers that do not choose a stream", async () => {
    const demuxer = createOpenedDemuxer();

    await demuxer.seek(12.5);

    expect(demuxer.bindings.seek).toHaveBeenCalledWith(12.5, -1, 1);
  });
});
