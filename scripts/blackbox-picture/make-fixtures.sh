#!/usr/bin/env bash
# Real media for the picture black-box, generated with ffmpeg.
#
#   subs.mkv   30 s of a blue picture with sound, and two subtitle tracks: ASS
#              ("Styled", one style in DejaVu Sans, with that font attached) and
#              SRT ("Plain"). One cue a second, ten times "i" in white.
#   sub.ass, sub.srt  the same cues as files, for <track> children.
#   DejaVuSans.ttf    the fallback font the page names.
#
# The picture is one colour, so whether it is on screen is a question of the
# average colour of a patch away from the cues and the controls: blue, or black.
set -euo pipefail

OUT="${1:-fixtures}"
FONTDIR="${MOVI_FONT_DIR:-/usr/share/fonts/truetype/dejavu}"
mkdir -p "$OUT"
cd "$OUT"

cp "$FONTDIR/DejaVuSans.ttf" DejaVuSans.ttf

cat > sub.ass <<'ASS'
[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
ASS
: > sub.srt
for t in $(seq 0 29); do
  printf 'Dialogue: 0,0:00:%02d.00,0:00:%02d.00,Default,,0,0,0,,iiiiiiiiii\n' "$t" "$((t + 1))" >> sub.ass
  printf '%d\n00:00:%02d,000 --> 00:00:%02d,000\niiiiiiiiii\n\n' "$((t + 1))" "$t" "$((t + 1))" >> sub.srt
done

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=0x2050D0:size=640x360:rate=25:duration=30" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=30" \
  -i sub.ass -i sub.srt \
  -map 0:v -map 1:a -map 2 -map 3 \
  -c:v libx264 -preset veryfast -g 25 -keyint_min 25 -sc_threshold 0 -pix_fmt yuv420p \
  -c:a aac -b:a 64k -c:s:0 ass -c:s:1 srt \
  -metadata:s:s:0 title=Styled -metadata:s:s:0 language=eng \
  -metadata:s:s:1 title=Plain -metadata:s:s:1 language=chi \
  -attach DejaVuSans.ttf -metadata:s:t:0 mimetype=application/x-truetype-font \
  subs.mkv

ffprobe -v error -show_entries stream=index,codec_name,codec_type:stream_tags=title,language -of compact subs.mkv
ls -l
