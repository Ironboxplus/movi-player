#!/usr/bin/env bash
# Real media for the font black-box, generated with ffmpeg.
#
#   fonts.mkv  30 s black picture, one ASS track whose only style asks for
#              "DejaVu Sans Mono", and 16 font attachments: 14 decoys (copies
#              of DejaVu Sans Bold, 10 MB between them), then DejaVu Sans and
#              DejaVu Sans Mono. Opening it must not read those 11 MB; selecting
#              the track must read the Mono body and nothing else of the bodies.
#   plain.mkv  the same without attachments: the control, which can only be drawn
#              in whatever font the player falls back to.
#   DejaVuSans.ttf, DejaVuSansMono.ttf  copies of the attached fonts, for finding
#              where each attachment sits in the file and as the fallback font.
#
# The picture is black and the one cue is ten times "i", in white with no
# outline: the only bright pixels on screen are the glyphs, and "i" is about
# 0.28 em wide in DejaVu Sans and 0.60 em in DejaVu Sans Mono, so the width of
# the ink says which of the two drew it.
set -euo pipefail

OUT="${1:-fixtures}"
FONTDIR="${MOVI_FONT_DIR:-/usr/share/fonts/truetype/dejavu}"
mkdir -p "$OUT"
cd "$OUT"

cp "$FONTDIR/DejaVuSans.ttf" DejaVuSans.ttf
cp "$FONTDIR/DejaVuSansMono.ttf" DejaVuSansMono.ttf

cat > sub.ass <<'ASS'
[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans Mono,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
ASS
# One cue a second, each a second long: a track picked a few seconds into the
# film still has cues ahead of it. (The player reads the packets of a track
# only once it is picked, so a single 30 s cue read before that would be gone.)
for t in $(seq 0 29); do
  printf 'Dialogue: 0,0:00:%02d.00,0:00:%02d.00,Default,,0,0,0,,iiiiiiiiii\n' "$t" "$((t + 1))" >> sub.ass
done

ATTACH=()
n=0
for i in $(seq 1 14); do
  cp "$FONTDIR/DejaVuSans-Bold.ttf" "Pad$i.ttf"
  ATTACH+=(-attach "Pad$i.ttf" "-metadata:s:t:$n" "mimetype=application/x-truetype-font")
  n=$((n + 1))
done
ATTACH+=(-attach DejaVuSans.ttf "-metadata:s:t:$n" "mimetype=application/x-truetype-font")
n=$((n + 1))
ATTACH+=(-attach DejaVuSansMono.ttf "-metadata:s:t:$n" "mimetype=application/x-truetype-font")

COMMON=(
  -hide_banner -loglevel error -y
  -f lavfi -i "color=c=black:size=640x360:rate=25:duration=30"
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=30"
  -i sub.ass
  -map 0:v -map 1:a -map 2
  -c:v libx264 -preset veryfast -g 25 -keyint_min 25 -sc_threshold 0 -pix_fmt yuv420p
  -c:a aac -b:a 64k -c:s ass
  -metadata:s:s:0 title=Styled -metadata:s:s:0 language=eng
)

ffmpeg "${COMMON[@]}" "${ATTACH[@]}" fonts.mkv
ffmpeg "${COMMON[@]}" plain.mkv

ffprobe -v error -show_entries stream=index,codec_name,codec_type:stream_tags=title,filename -of compact fonts.mkv | head -30
ls -l
