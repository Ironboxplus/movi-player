#ifndef MOVI_H
#define MOVI_H

#include <emscripten.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavformat/avio.h>
#include <libavutil/avutil.h>
#include <libavutil/display.h>
#include <libavutil/pixdesc.h>
#include <libavutil/spherical.h>
#include <libavutil/time.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>



// Stream types matching TypeScript
typedef enum {
  STREAM_TYPE_VIDEO = 0,
  STREAM_TYPE_AUDIO = 1,
  STREAM_TYPE_SUBTITLE = 2,
  STREAM_TYPE_UNKNOWN = 3
} StreamType;

// Stream info struct - matches TypeScript
typedef struct {
  int index;
  int type;
  int codec_id;
  char codec_name[32];
  int width;
  int height;
  double frame_rate;
  int channels;
  int sample_rate;
  double duration;
  int64_t bit_rate;
  int extradata_size;
  int profile;
  int level;
  char language[8]; // ISO 639-2/B language code (3 chars + null terminator)
  char label[64];   // Track label/title from metadata
  int rotation;     // Rotation in degrees (e.g. 0, 90, 180, 270)
  char color_primaries[32];
  char color_transfer[32];
  char color_matrix[32];
  char pixel_format[32];
  char color_range[32];
  // 360° spherical projection, stored as AVSphericalProjection + 1 so that a
  // zero-initialised struct (i.e. an older WASM that predates this field) reads
  // as 0 = "no spherical metadata" rather than 0 = equirectangular.
  //   0 = none/not spherical
  //   1 = equirectangular, 2 = cubemap, 3 = equirectangular-tile,
  //   4 = half-equirectangular (180°), …
  int projection;
} StreamInfo;

// Packet info struct
typedef struct {
  int stream_index;
  int keyframe;
  double timestamp;
  double dts;
  double duration;
  int size;
  // 1 only for a TRUE random-access keyframe the HW decoder will accept as a
  // `key` chunk: IDR/BLA in HEVC, IDR in H.264, key+no-show-existing in AV1.
  // 0 for CRA / open-GOP sync frames that AVPacket flags as a keyframe but
  // whose leading (RASL) pictures reference the previous GOP — sending those
  // as `key` makes WebCodecs reject them ("wasn't a key frame"). JS sends
  // is_idr=0 keyframes as `delta` mid-stream so the HW decoder keeps running.
  // Occupies the 4 bytes the compiler already pads after `size`.
  int is_idr;
  // 1 for an HEVC RASL leading picture (NAL type 8=RASL_N / 9=RASL_R). RASL
  // pictures follow a CRA in decode order but reference the PRE-CRA GOP. When a
  // CRA is used as a random-access point (post-seek, references flushed) its
  // RASL pictures are non-decodable and the spec discards them
  // (NoRaslOutputFlag=1). Chrome's decoder drops them internally; Safari's
  // VideoToolbox throws a hard EncodingError instead. JS uses this to skip RASL
  // after resuming on a CRA. Always 0 for keyframes and non-HEVC codecs.
  // Growing the struct here bumps sizeof(PacketInfo) 40 -> 48 (double alignment
  // pads the trailing 44 to 48); PACKET_INFO_SIZE in types.ts must match.
  int is_rasl;
  // 1 for a disposable (non-reference) frame. Nothing in the stream references
  // it, so it can be dropped without breaking decode. Taken from
  // AV_PKT_FLAG_DISPOSABLE where the container carries the sample-dependency
  // information, and otherwise derived from the bitstream — most plain MP4s
  // have no sdtp box and flag nothing at all (see movi_packet_is_non_ref).
  // JS drops these before WebCodecs on the hardware/software-in-browser path
  // when the renderer reports the device can't sustain the source rate, and
  // spends them first when an audio starve forces it to skip video. Fills
  // the 4 padding bytes after is_rasl, so sizeof(PacketInfo) stays 48.
  int disposable;
} PacketInfo;

// Prefetched subtitle cue (populated by movi_prefetch_subtitle_cues).
// Used for negative subtitle delay where the renderer needs cues from
// future stream positions before the demuxer would naturally deliver them.
typedef struct {
  double start_sec;
  double end_sec;
  char *text; // null-terminated, malloc-owned
} PrefetchedSubCue;

// Seeking a Matroska that carries no usable index: see movi_streams.c. Shared
// with the thumbnail pipeline, which opens its own AVFormatContext over the
// same file and would otherwise read forward from the start for every preview.
int movi_fmt_is_matroska(const AVFormatContext *fmt);
int movi_mkv_index_misses(AVStream *st, double target_sec);
int movi_mkv_index_near_fmt(AVFormatContext *fmt, int64_t file_size, int anchor,
                            double target_sec);

// The same question, and the same answer, for a transport stream: no index,
// and a timestamp bisection that lands past the random-access point the target
// belongs to. See movi_streams.c.
// How far behind the target an indexed point may sit before it is worth
// scanning for a closer one. About a GOP: landing further back than that means
// decoding a stretch of frames only to drop them, which is the cost the scan
// exists to remove — and the scan is a few small reads, cheaper than the
// decode it saves. Seeks inside the same GOP still answer from the index.
#define MOVI_TS_INDEX_TOLERANCE_S 2.0
// …but a point THIS far back is still worth landing on once the scan has said
// there is nothing closer: decoding a few seconds of frames and dropping them
// costs less than what the alternative does, which is to wait out a GOP and
// then resume PAST the playhead. Two separate numbers because they answer two
// separate questions — the first is "look again?", this one is "use it?".
#define MOVI_TS_LAND_MAX_S 5.0
int movi_fmt_is_mpegts(const AVFormatContext *fmt);
int movi_ts_index_near_fmt(AVFormatContext *fmt, int64_t file_size, int anchor,
                           double target_sec);
// Can this stream's index answer a seek to `target_sec`, or is the nearest
// entry so far behind that landing there means reading through the stretch the
// index was meant to skip?
int movi_index_misses(AVStream *st, double target_sec, double tolerance_s);
// Move the demuxer onto the random-access point that owns `target_sec`, by the
// byte offset the index holds for it. 0 when it moved.
int movi_ts_seek_to_rap(AVFormatContext *fmt, int anchor, double target_sec);

// Demuxer context with custom AVIO
typedef struct {
  AVFormatContext *fmt_ctx;
  AVPacket *pkt;
  AVIOContext *avio_ctx;
  uint8_t *avio_buffer;
  int64_t position;  // Current read position
  int64_t file_size; // Total file size
  int avio_buffer_size;
  // How far FFmpeg may read, and how much media it may analyse, before it will
  // name the streams. Zero means "use the default" — see movi_set_probe_limits.
  int64_t probe_size;
  int64_t max_analyze_us;

  // Decoding support
  AVCodecContext **decoders;
  SwrContext **resamplers;
  AVFrame *frame;
  AVFrame *resampled_frame;
  AVSubtitle *subtitle;                 // For subtitle decoding
  double last_subtitle_packet_duration; // Store packet duration for fallback
  int downmix_to_stereo;
  
  // RGB conversion support (for 10-bit HDR to 8-bit RGBA)
  struct SwsContext *sws_ctx;
  AVFrame *rgb_frame;
  uint8_t *rgb_buffer;
  int rgb_buffer_size;
  int rgb_data_size;

  // Prefetched subtitle cues (lazy — populated on demand for non-zero
  // subtitle delay). Owned by the context; freed in movi_destroy.
  PrefetchedSubCue *prefetched_cues;
  int prefetched_cue_count;
  int prefetched_cue_capacity;

  // ---- Batched audio decode accumulation --------------------------------
  // Decoding one packet per JS→WASM round-trip is fine for AAC (1024 frames a
  // packet ≈ 47 packets/s) but brutal for TrueHD/MLP, whose access unit is only
  // 40 samples (~0.8 ms) — ~1200 packets/s, each costing a send, two receives,
  // three getters and a plane pointer per channel, plus a tiny typed-array copy
  // per channel. That's ~9600 boundary crossings and ~2400 allocations for one
  // second of audio, and it's the per-packet overhead — not the decode math —
  // that starves the renderer after a seek. movi_decode_audio_batch decodes many
  // packets in a single call and accumulates the PCM here, so JS makes one copy
  // per channel for the whole batch. Owned by the context; freed in movi_destroy.
  float **abatch;        // abatch_channels contiguous planes
  int abatch_channels;   // channels the planes were allocated for
  int abatch_capacity;   // samples each plane can hold
  int abatch_nb_samples; // samples currently accumulated
  int abatch_sample_rate;
  double abatch_pts;   // pts (seconds) of the first accumulated frame
  int abatch_has_pts;  // 0 until the first frame lands
} MoviContext;

// Release the batched-audio accumulation planes (called from movi_destroy).
void movi_abatch_free(MoviContext *ctx);

typedef struct {
  AVCodecContext *dec_ctx;
  SwrContext *swr_ctx;
  AVFrame *frame;
  AVFrame *resampled_frame;
  AVChannelLayout swr_in_layout;
  AVChannelLayout swr_out_layout;
  enum AVSampleFormat swr_in_sample_fmt;
  enum AVSampleFormat swr_out_sample_fmt;
  int swr_in_sample_rate;
  int swr_out_sample_rate;
  int swr_target_channels;
  int swr_configured;
  int downmix_to_stereo;
} MoviAudioDecoderContext;

typedef struct {
  AVCodecContext *dec_ctx;
  AVFrame *frame;
  struct SwsContext *sws_ctx;
  AVFrame *rgb_frame;
  uint8_t *rgb_buffer;
  int rgb_buffer_size;
  int rgb_data_size;
} MoviVideoDecoderContext;

EMSCRIPTEN_KEEPALIVE MoviAudioDecoderContext *movi_audio_decoder_create(
    int codec_id, int sample_rate, int channels, uint8_t *extradata,
    int extradata_size);
EMSCRIPTEN_KEEPALIVE void
movi_audio_decoder_destroy(MoviAudioDecoderContext *ctx);
EMSCRIPTEN_KEEPALIVE void
movi_audio_decoder_enable_downmix(MoviAudioDecoderContext *ctx, int enable);
EMSCRIPTEN_KEEPALIVE int movi_audio_decoder_send_packet(
    MoviAudioDecoderContext *ctx, uint8_t *data, int size, double pts,
    double dts, int keyframe);
EMSCRIPTEN_KEEPALIVE int
movi_audio_decoder_receive_frame(MoviAudioDecoderContext *ctx);
EMSCRIPTEN_KEEPALIVE void
movi_audio_decoder_flush(MoviAudioDecoderContext *ctx);
EMSCRIPTEN_KEEPALIVE int
movi_audio_decoder_get_frame_samples(MoviAudioDecoderContext *ctx);
EMSCRIPTEN_KEEPALIVE int
movi_audio_decoder_get_frame_channels(MoviAudioDecoderContext *ctx);
EMSCRIPTEN_KEEPALIVE int
movi_audio_decoder_get_frame_sample_rate(MoviAudioDecoderContext *ctx);
EMSCRIPTEN_KEEPALIVE uint8_t *
movi_audio_decoder_get_frame_data(MoviAudioDecoderContext *ctx, int plane);

EMSCRIPTEN_KEEPALIVE MoviVideoDecoderContext *movi_video_decoder_create(
    int codec_id, int width, int height, uint8_t *extradata,
    int extradata_size);
EMSCRIPTEN_KEEPALIVE void
movi_video_decoder_destroy(MoviVideoDecoderContext *ctx);
EMSCRIPTEN_KEEPALIVE void movi_video_decoder_set_skip_frame(
    MoviVideoDecoderContext *ctx, int skip_val);
EMSCRIPTEN_KEEPALIVE int movi_video_decoder_send_packet(
    MoviVideoDecoderContext *ctx, uint8_t *data, int size, double pts,
    double dts, int keyframe);
EMSCRIPTEN_KEEPALIVE int
movi_video_decoder_receive_frame(MoviVideoDecoderContext *ctx);
EMSCRIPTEN_KEEPALIVE void
movi_video_decoder_flush(MoviVideoDecoderContext *ctx);
EMSCRIPTEN_KEEPALIVE int
movi_video_decoder_get_frame_width(MoviVideoDecoderContext *ctx);
EMSCRIPTEN_KEEPALIVE int
movi_video_decoder_get_frame_height(MoviVideoDecoderContext *ctx);
EMSCRIPTEN_KEEPALIVE int
movi_video_decoder_get_frame_format(MoviVideoDecoderContext *ctx);
EMSCRIPTEN_KEEPALIVE int
movi_video_decoder_get_frame_webcodecs_format(MoviVideoDecoderContext *ctx);
EMSCRIPTEN_KEEPALIVE uint8_t *
movi_video_decoder_get_frame_data(MoviVideoDecoderContext *ctx, int plane);
EMSCRIPTEN_KEEPALIVE int
movi_video_decoder_get_frame_linesize(MoviVideoDecoderContext *ctx, int plane);
EMSCRIPTEN_KEEPALIVE double
movi_video_decoder_get_frame_pts(MoviVideoDecoderContext *ctx);
EMSCRIPTEN_KEEPALIVE uint8_t *movi_video_decoder_get_frame_rgba(
    MoviVideoDecoderContext *ctx, int target_width, int target_height);
EMSCRIPTEN_KEEPALIVE int
movi_video_decoder_get_frame_rgba_size(MoviVideoDecoderContext *ctx);
EMSCRIPTEN_KEEPALIVE int
movi_video_decoder_get_frame_rgba_linesize(MoviVideoDecoderContext *ctx);

int movi_frame_webcodecs_format(const AVFrame *frame);

// Defined in movi_decode.c; movi_decode_audio_batch drives these internally.
EMSCRIPTEN_KEEPALIVE int movi_send_packet(MoviContext *ctx, int stream_index,
                                          uint8_t *data, int size, double pts,
                                          double dts, int keyframe);
EMSCRIPTEN_KEEPALIVE int movi_receive_frame(MoviContext *ctx, int stream_index);

EMSCRIPTEN_KEEPALIVE double movi_get_start_time(MoviContext *ctx);
EMSCRIPTEN_KEEPALIVE int movi_get_format_name(MoviContext *ctx, char *buffer, int buffer_size);
EMSCRIPTEN_KEEPALIVE int movi_get_metadata_title(MoviContext *ctx, char *buffer, int buffer_size);
EMSCRIPTEN_KEEPALIVE int movi_get_metadata_tag(MoviContext *ctx, const char *key, char *buffer, int buffer_size);

// JS-WASM Bridge (defined in movi.c or other files with EM_JS)
extern int js_read_async(uint8_t *buffer, int offset_low, int offset_high,
                         int size);
extern int64_t js_seek_async(int offset_low, int offset_high, int whence);
extern int64_t js_get_file_size(void);

// Remuxer context (forward declaration)
typedef struct MoviRemuxContext MoviRemuxContext;

// Thumbnail context (forward declaration)
typedef struct MoviThumbnailContext MoviThumbnailContext;

#endif // MOVI_H
