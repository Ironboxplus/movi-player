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
  it("uses active-stream strict seek before broad Matroska/global fallbacks", () => {
    const sectionStart = streamsSource.indexOf("int movi_seek_to");
    const sectionEnd = streamsSource.indexOf("// After seek, clear stale EOF state", sectionStart);
    expect(sectionStart).toBeGreaterThanOrEqual(0);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    const seekSection = streamsSource.slice(sectionStart, sectionEnd);

    expect(seekSection).toContain(
      "stream_index >= 0 &&\n      stream_index < (int)ctx->fmt_ctx->nb_streams",
    );
    expect(seekSection).toContain(
      "av_rescale_q(seek_target, AV_TIME_BASE_Q, stream->time_base)",
    );
    expect(seekSection).toContain(
      "avformat_seek_file(ctx->fmt_ctx, stream_index, INT64_MIN,\n                             stream_target, stream_target, seek_flags)",
    );
    expect(seekSection).toContain(
      "avformat_seek_file(ctx->fmt_ctx, stream_index, INT64_MIN,\n                               stream_target, INT64_MAX, seek_flags)",
    );
    expect(seekSection.indexOf("stream_target, stream_target")).toBeLessThan(
      seekSection.indexOf("stream_target, INT64_MAX"),
    );
    expect(seekSection).toContain("avformat_seek_file(ctx->fmt_ctx, -1");
  });

  it("guards a zero stream time_base before av_rescale_q (no div-by-zero trap)", () => {
    const sectionStart = streamsSource.indexOf("int movi_seek_to");
    const sectionEnd = streamsSource.indexOf("// After seek, clear stale EOF state", sectionStart);
    const seekSection = streamsSource.slice(sectionStart, sectionEnd);
    // The per-stream rescale path must only be entered when the denominator is
    // non-zero, otherwise av_rescale_q(..., stream->time_base) divides by zero.
    expect(seekSection).toContain(
      "ctx->fmt_ctx->streams[stream_index]->time_base.den != 0",
    );
    expect(
      seekSection.indexOf("time_base.den != 0"),
    ).toBeLessThan(seekSection.indexOf("av_rescale_q(seek_target"));
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
