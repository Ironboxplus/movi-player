import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const header = readFileSync("wasm/movi.h", "utf8");
const source = readFileSync("wasm/movi_decode.c", "utf8");
const wasmTypes = readFileSync("src/wasm/types.ts", "utf8");
const buildScript = readFileSync("docker/build-ffmpeg.sh", "utf8");
const demuxerSource = readFileSync("src/demux/Demuxer.ts", "utf8");

const standaloneVideoSymbols = [
  "movi_video_decoder_create",
  "movi_video_decoder_destroy",
  "movi_video_decoder_set_skip_frame",
  "movi_video_decoder_send_packet",
  "movi_video_decoder_receive_frame",
  "movi_video_decoder_flush",
  "movi_video_decoder_get_frame_width",
  "movi_video_decoder_get_frame_height",
  "movi_video_decoder_get_frame_format",
  "movi_video_decoder_get_frame_webcodecs_format",
  "movi_video_decoder_get_frame_data",
  "movi_video_decoder_get_frame_linesize",
  "movi_video_decoder_get_frame_pts",
  "movi_video_decoder_get_frame_rgba",
  "movi_video_decoder_get_frame_rgba_size",
  "movi_video_decoder_get_frame_rgba_linesize",
] as const;

describe("standalone WASM video decoder source contract", () => {
  it("provides one codec-agnostic decoder context for Worker-owned decoding", () => {
    expect(header).toContain("MoviVideoDecoderContext");
    expect(source).toContain("avcodec_find_decoder((enum AVCodecID)codec_id)");
    expect(source).toContain("ctx->dec_ctx->pkt_timebase = AV_TIME_BASE_Q");
    expect(source).toContain("AV_INPUT_BUFFER_PADDING_SIZE");
    expect(source).toContain("if (isfinite(pts))");
    expect(source).toContain("if (isfinite(dts))");
    expect(source).toContain("return pts == AV_NOPTS_VALUE ? NAN");

    for (const symbol of standaloneVideoSymbols) {
      expect(header).toContain(symbol);
      expect(source).toContain(symbol);
      expect(wasmTypes).toContain(`_${symbol}`);
      expect(buildScript).toContain(`\"_${symbol}\"`);
    }
  });

  it("has a Worker pipeline that owns decoding and frame construction", () => {
    const workerPath = "src/decode/SoftwareVideoDecoder.worker.ts";
    expect(existsSync(workerPath)).toBe(true);
    const worker = readFileSync(workerPath, "utf8");

    expect(worker).toContain("loadWasmModuleNew");
    expect(worker).toContain("_movi_video_decoder_create");
    expect(worker).toContain("_movi_video_decoder_send_packet");
    expect(worker).toContain("_movi_video_decoder_receive_frame");
    expect(worker).toContain("_movi_video_decoder_get_frame_webcodecs_format");
    expect(worker).toContain("_movi_video_decoder_get_frame_rgba");
    expect(worker).toContain("new VideoFrame");
    expect(worker).toContain("[frame]");
  });

  it("preserves FFmpeg codecId on video tracks for codec-agnostic Worker setup", () => {
    const videoCaseStart = demuxerSource.indexOf("case 0: // Video");
    const audioCaseStart = demuxerSource.indexOf("case 1: // Audio", videoCaseStart);
    expect(videoCaseStart).toBeGreaterThanOrEqual(0);
    expect(audioCaseStart).toBeGreaterThan(videoCaseStart);
    expect(demuxerSource.slice(videoCaseStart, audioCaseStart)).toContain(
      "codecId: info.codecId",
    );
  });
});
