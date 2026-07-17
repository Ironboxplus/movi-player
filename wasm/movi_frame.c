#include "movi.h"

EMSCRIPTEN_KEEPALIVE
int movi_get_frame_width(MoviContext *ctx) {
  return ctx->frame ? ctx->frame->width : 0;
}
EMSCRIPTEN_KEEPALIVE
int movi_get_frame_height(MoviContext *ctx) {
  return ctx->frame ? ctx->frame->height : 0;
}
EMSCRIPTEN_KEEPALIVE
int movi_get_frame_format(MoviContext *ctx) {
  return ctx->frame ? ctx->frame->format : 0;
}

// Stable format ids shared with WasmBindings. Do not expose AVPixelFormat
// numeric values to JavaScript: FFmpeg may add formats while these ids remain
// under our control.
//   0 unsupported
//   1-5   I420 family
//   6-10  I422 family
//   11-15 I444 family
//   16    NV12
//   17-20 packed 8-bit RGB
int movi_frame_webcodecs_format(const AVFrame *frame) {
  if (!frame)
    return 0;

  switch ((enum AVPixelFormat)frame->format) {
  case AV_PIX_FMT_YUV420P:
  case AV_PIX_FMT_YUVJ420P:
    return 1; // I420
  case AV_PIX_FMT_YUV420P10LE:
    return 2; // I420P10
  case AV_PIX_FMT_YUV420P12LE:
    return 3; // I420P12
  case AV_PIX_FMT_YUVA420P:
    return 4; // I420A
  case AV_PIX_FMT_YUVA420P10LE:
    return 5; // I420AP10

  case AV_PIX_FMT_YUV422P:
  case AV_PIX_FMT_YUVJ422P:
    return 6; // I422
  case AV_PIX_FMT_YUV422P10LE:
    return 7; // I422P10
  case AV_PIX_FMT_YUV422P12LE:
    return 8; // I422P12
  case AV_PIX_FMT_YUVA422P:
    return 9; // I422A
  case AV_PIX_FMT_YUVA422P10LE:
    return 10; // I422AP10

  case AV_PIX_FMT_YUV444P:
  case AV_PIX_FMT_YUVJ444P:
    return 11; // I444
  case AV_PIX_FMT_YUV444P10LE:
    return 12; // I444P10
  case AV_PIX_FMT_YUV444P12LE:
    return 13; // I444P12
  case AV_PIX_FMT_YUVA444P:
    return 14; // I444A
  case AV_PIX_FMT_YUVA444P10LE:
    return 15; // I444AP10

  case AV_PIX_FMT_NV12:
    return 16;
  case AV_PIX_FMT_RGBA:
    return 17;
  case AV_PIX_FMT_RGB0:
    return 18;
  case AV_PIX_FMT_BGRA:
    return 19;
  case AV_PIX_FMT_BGR0:
    return 20;
  default:
    return 0;
  }
}

EMSCRIPTEN_KEEPALIVE
int movi_get_frame_webcodecs_format(MoviContext *ctx) {
  return ctx ? movi_frame_webcodecs_format(ctx->frame) : 0;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *movi_get_frame_data(MoviContext *ctx, int plane) {
  return (ctx->frame && plane >= 0 && plane < AV_NUM_DATA_POINTERS)
             ? ctx->frame->data[plane]
             : NULL;
}

EMSCRIPTEN_KEEPALIVE
int movi_get_frame_linesize(MoviContext *ctx, int plane) {
  return (ctx->frame && plane >= 0 && plane < AV_NUM_DATA_POINTERS)
             ? ctx->frame->linesize[plane]
             : 0;
}

EMSCRIPTEN_KEEPALIVE
int movi_get_frame_samples(MoviContext *ctx) {
  return ctx->frame ? ctx->frame->nb_samples : 0;
}
EMSCRIPTEN_KEEPALIVE
int movi_get_frame_channels(MoviContext *ctx) {
  return ctx->frame ? ctx->frame->ch_layout.nb_channels : 0;
}
EMSCRIPTEN_KEEPALIVE
int movi_get_frame_sample_rate(MoviContext *ctx) {
  return ctx->frame ? ctx->frame->sample_rate : 0;
}
