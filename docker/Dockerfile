# syntax=docker/dockerfile:1
# PINNED to 6.0.1 (was :latest). emsdk :latest rolled to 6.0.3, whose bundled
# wasm-ld SIGSEGVs during -flto LTO codegen (crash in llvm SelectionDAG::
# isKnownNeverNaN) — the link step of build:wasm dies with SIGSEGV, no code error.
# 6.0.1 is the toolchain the 4090 uses to hand-build the speed WASM and is
# known-good; it still has the resizable-heap behavior our decodeUtf8() copy fix
# already handles. Revisit when a newer emsdk fixes the wasm-ld LTO crash.
FROM emscripten/emsdk:6.0.1

LABEL maintainer="movi"
LABEL description="FFmpeg WASM build environment for movi"

# Apt reads its archive through a mirror list (apt-transport-mirror(1)): tried
# by priority, the next one when one fails. On 2026-11-11 GitHub's runners could
# not resolve *.ubuntu.com for over an hour and every package build failed here:
# kernel.org's Ubuntu mirror goes first, archive.ubuntu.com after it.
RUN printf 'http://mirrors.edge.kernel.org/ubuntu/\tpriority:1\nhttp://archive.ubuntu.com/ubuntu/\n' > /etc/apt/mirrors.txt \
    && for f in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do \
         [ -f "$f" ] && sed -i -E 's#https?://(archive|security)\.ubuntu\.com/ubuntu/?#mirror+file:/etc/apt/mirrors.txt#g' "$f"; \
       done; \
    grep -rqs 'mirror+file' /etc/apt/sources.list /etc/apt/sources.list.d/

# Install build dependencies (including meson/ninja for dav1d)
RUN apt-get update && apt-get install -y \
    git \
    make \
    pkg-config \
    meson \
    ninja-build \
    nasm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Clone dav1d AV1 decoder (software, works great in WASM)
ARG DAV1D_VERSION=1.5.3
RUN git clone --depth 1 --branch ${DAV1D_VERSION} https://code.videolan.org/videolan/dav1d.git /opt/dav1d

# Clone FFmpeg (will be mounted from host for dev, or cloned for CI)
ARG FFMPEG_VERSION=n9.0.2
RUN git clone --depth 1 --branch ${FFMPEG_VERSION} https://github.com/FFmpeg/FFmpeg.git /opt/FFmpeg

# Local FFmpeg patches (docker/patches/*.patch). git apply, not patch: git is
# already here, and it fails the build loudly when upstream moves a hunk.
#   ffmpeg-matroska-lazy-attachments.patch  matroskadec records where an
#   attachment's body is instead of reading it at open; see the patch header.
COPY patches /opt/patches
RUN cd /opt/FFmpeg && for p in /opt/patches/*.patch; do echo "applying $p"; git apply --verbose "$p"; done

# Build script
COPY build-ffmpeg.sh /opt/build-ffmpeg.sh
RUN chmod +x /opt/build-ffmpeg.sh

ENV FFMPEG_SRC=/opt/FFmpeg

CMD ["/opt/build-ffmpeg.sh"]
