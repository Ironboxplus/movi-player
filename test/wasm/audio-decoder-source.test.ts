import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Normalize CRLF -> LF: the working tree may be checked out with either line
// ending (Windows autocrlf), and the multi-line source assertions below match
// on "\n". Without this, the same source passes on Linux CI but fails locally.
const header = readFileSync("wasm/movi.h", "utf8").replace(/\r\n/g, "\n");
const source = readFileSync("wasm/movi_decode.c", "utf8").replace(/\r\n/g, "\n");
const streamsSource = readFileSync("wasm/movi_streams.c", "utf8").replace(/\r\n/g, "\n");

function sliceBetween(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("standalone WASM audio decoder source contract", () => {
  it("tracks SwrContext parameters so audio format changes recreate the converter", () => {
    expect(header).toContain("AVChannelLayout swr_in_layout");
    expect(header).toContain("AVChannelLayout swr_out_layout");
    expect(header).toContain("enum AVSampleFormat swr_in_sample_fmt");
    expect(header).toContain("int swr_in_sample_rate");
    expect(header).toContain("int swr_target_channels");
    expect(header).toContain("int swr_configured");

    expect(source).toContain("movi_audio_decoder_swr_matches");
    expect(source).toContain("movi_audio_decoder_reset_swr");
    expect(source).toContain("av_channel_layout_compare");
  });

  it("uses owned AVChannelLayout copies for standalone audio SWR setup", () => {
    expect(source).toContain("movi_audio_build_in_layout(&in_layout");
    expect(source).toContain("return src ? av_channel_layout_copy(dst, src) : -1;");
    expect(source).toContain("av_channel_layout_uninit(&in_layout)");
    expect(source).not.toContain("AVChannelLayout in_layout = ctx->frame->ch_layout;");
  });

  it("resets standalone audio SWR state through one cleanup helper", () => {
    const lifecycleSection = sliceBetween(
      "void movi_audio_decoder_destroy",
      "int movi_audio_decoder_send_packet",
    );
    const flushSection = sliceBetween(
      "void movi_audio_decoder_flush",
      "int movi_audio_decoder_get_frame_samples",
    );

    expect(lifecycleSection).toContain("movi_audio_decoder_reset_swr(ctx);");
    expect(flushSection).toContain("movi_audio_decoder_reset_swr(ctx);");
    expect(lifecycleSection).not.toContain("swr_free(&ctx->swr_ctx)");
    expect(flushSection).not.toContain("swr_free(&ctx->swr_ctx)");
  });
});

describe("WASM stream seek source contract", () => {
  // movi_seek_to anchors on a video stream (upstream 0.4.1), not on whatever
  // stream index the caller passed; the contracts below are the same ones the
  // earlier active-stream wording pinned, spelled with the anchor.
  const seekSection = () => {
    const sectionStart = streamsSource.indexOf("int movi_seek_to");
    const sectionEnd = streamsSource.indexOf("// After seek, clear stale EOF state", sectionStart);
    expect(sectionStart).toBeGreaterThanOrEqual(0);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    // Whitespace-normalized so the assertions survive clang-format reflow.
    return streamsSource.slice(sectionStart, sectionEnd).replace(/\s+/g, " ");
  };

  it("uses the anchor stream strict seek before broad Matroska/global fallbacks", () => {
    const sec = seekSection();
    expect(sec).toContain("anchor >= (int)ctx->fmt_ctx->nb_streams");
    expect(sec).toContain("av_find_best_stream(ctx->fmt_ctx, AVMEDIA_TYPE_VIDEO");
    const strict = sec.indexOf(
      "avformat_seek_file(ctx->fmt_ctx, anchor, INT64_MIN, stream_target, stream_target, seek_flags)",
    );
    const perStream = sec.indexOf("av_seek_frame(ctx->fmt_ctx, anchor, stream_target, seek_flags)");
    const broad = sec.indexOf(
      "avformat_seek_file(ctx->fmt_ctx, anchor, INT64_MIN, stream_target, INT64_MAX, seek_flags)",
    );
    expect(strict).toBeGreaterThanOrEqual(0);
    expect(perStream).toBeGreaterThan(strict);
    expect(broad).toBeGreaterThan(perStream);
    expect(sec).toContain("avformat_seek_file(ctx->fmt_ctx, -1");
  });

  it("guards a zero stream time_base before the per-stream rescale (no div-by-zero trap)", () => {
    const sec = seekSection();
    // The per-stream path must only be entered when the denominator is
    // non-zero, otherwise the stream_target rescale divides by zero.
    expect(sec).toContain("ctx->fmt_ctx->streams[anchor]->time_base.den != 0");
    expect(sec.indexOf("time_base.den != 0")).toBeLessThan(
      sec.indexOf("avformat_seek_file(ctx->fmt_ctx, anchor"),
    );
  });

  it("converges the global fallback max_ts to seek_target before broadening", () => {
    const sectionStart = streamsSource.indexOf("int movi_seek_to");
    const sectionEnd = streamsSource.indexOf("// After seek, clear stale EOF state", sectionStart);
    // Whitespace-normalized so the assertion survives clang-format reflow of the
    // multi-line call arguments.
    const seekSection = streamsSource
      .slice(sectionStart, sectionEnd)
      .replace(/\s+/g, " ");
    // Global fallback: strict backward window (max_ts = seek_target) FIRST so an
    // interleaved MKV whose only cue points are on the audio track cannot land
    // FFmpeg minutes past the target and trigger the packet-storm download.
    const strictGlobal = seekSection.indexOf(
      "avformat_seek_file(ctx->fmt_ctx, -1, INT64_MIN, seek_target, seek_target, seek_flags)",
    );
    const broadGlobal = seekSection.indexOf(
      "avformat_seek_file(ctx->fmt_ctx, -1, INT64_MIN, seek_target, INT64_MAX, seek_flags)",
    );
    expect(strictGlobal).toBeGreaterThanOrEqual(0);
    expect(broadGlobal).toBeGreaterThan(strictGlobal);
  });

  it("does not downgrade H.264 container keyframes with fragile VCL parsing", () => {
    const sectionStart = streamsSource.indexOf("static int movi_packet_is_idr");
    const sectionEnd = streamsSource.indexOf("static int movi_packet_is_rasl", sectionStart);
    expect(sectionStart).toBeGreaterThanOrEqual(0);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    const idrSection = streamsSource.slice(sectionStart, sectionEnd);

    expect(idrSection).toContain("if (codec_id == AV_CODEC_ID_H264)");
    expect(idrSection).toContain("return 1;");
    expect(idrSection.indexOf("if (codec_id == AV_CODEC_ID_H264)")).toBeLessThan(
      idrSection.indexOf("movi_first_vcl_nal_type"),
    );
  });
});
