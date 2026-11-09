#!/usr/bin/env bash
# Real media for the source/subtitle black-box, generated with ffmpeg. H.264 +
# AAC only: the runner's headless Chrome has no HEVC hardware decode.
#
#   orig.mkv        20 s 854x480, four embedded text subtitle tracks (titled;
#                   the last one is ASS), each with its own readable cue text
#   hls360/ hls240/ the same picture as HLS (m3u8 + ts), no subtitles, standing
#                   in for 115's cloud transcodes
#   s0.srt..s2.srt  the first three tracks exported as files, standing in for
#                   115's extracted subtitles; the ASS track is left out on
#                   purpose, so it must show up greyed out on a rendition
#
# Cue text is "SUB-<track>-A" at 2-6 s and "SUB-<track>-B" at 10-14 s, so which
# subtitle is on screen, and when, can be read straight off the page.
set -euo pipefail

OUT="${1:-fixtures}"
mkdir -p "$OUT"
cd "$OUT"

for i in 0 1 2; do
  cat > "s$i.srt" <<SRT
1
00:00:02,000 --> 00:00:06,000
SUB-$i-A

2
00:00:10,000 --> 00:00:14,000
SUB-$i-B
SRT
done

cat > s3.ass <<'ASS'
[Script Info]
ScriptType: v4.00+
PlayResX: 854
PlayResY: 480

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:02.00,0:00:06.00,Default,,0,0,0,,SUB-3-A
Dialogue: 0,0:00:10.00,0:00:14.00,Default,,0,0,0,,SUB-3-B
ASS

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=854x480:rate=25:duration=20" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=20" \
  -i s0.srt -i s1.srt -i s2.srt -i s3.ass \
  -map 0:v -map 1:a -map 2 -map 3 -map 4 -map 5 \
  -c:v libx264 -preset veryfast -g 25 -keyint_min 25 -sc_threshold 0 -pix_fmt yuv420p \
  -c:a aac -b:a 96k \
  -c:s:0 srt -c:s:1 srt -c:s:2 srt -c:s:3 ass \
  -metadata:s:s:0 title="English" -metadata:s:s:0 language=eng \
  -metadata:s:s:1 title="简体中文" -metadata:s:s:1 language=chi \
  -metadata:s:s:2 title="Español" -metadata:s:s:2 language=spa \
  -metadata:s:s:3 title="Styled" -metadata:s:s:3 language=eng \
  orig.mkv

for h in 360 240; do
  mkdir -p "hls$h"
  ffmpeg -hide_banner -loglevel error -y -i orig.mkv \
    -map 0:v -map 0:a -sn \
    -c:v libx264 -preset veryfast -vf "scale=-2:$h" -g 25 -keyint_min 25 -sc_threshold 0 -pix_fmt yuv420p \
    -c:a aac -b:a 64k \
    -f hls -hls_time 4 -hls_playlist_type vod \
    -hls_segment_filename "hls$h/seg%03d.ts" "hls$h/index.m3u8"
done

ffprobe -v error -show_entries stream=index,codec_name,codec_type:stream_tags=title,language -of compact orig.mkv
ls -l
