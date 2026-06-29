import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const header = readFileSync("wasm/movi.h", "utf8");
const source = readFileSync("wasm/movi_decode.c", "utf8");

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
