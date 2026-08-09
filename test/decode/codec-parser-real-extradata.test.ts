import { describe, expect, it } from "vitest";
import { CodecParser } from "../../src/decode/CodecParser";

describe("CodecParser real H.264 avcC recovery", () => {
  it("recovers High@4.1 from the SPS when the avcC summary bytes are zero", () => {
    // Exact 35-byte extradata from the real Good Will Hunting H.264 REMUX.
    // Its avcC profile/compat/level summary is zeroed, but the first SPS is
    // valid and starts 67 64 00 29 (NAL type 7, High profile, level 4.1).
    const extradata = Uint8Array.from(
      Buffer.from(
        "01000000ffe1001367640029ac2ca501e0089f97ff00010001008001000568e9083525",
        "hex",
      ),
    );

    expect(CodecParser.getCodecString("h264", extradata)).toBe("avc1.640029");
  });

  it("keeps a valid avcC summary authoritative", () => {
    const extradata = Uint8Array.from([
      1, 0x64, 0, 0x29, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0, 0x1f,
    ]);
    expect(CodecParser.getCodecString("h264", extradata)).toBe("avc1.640029");
  });
});
