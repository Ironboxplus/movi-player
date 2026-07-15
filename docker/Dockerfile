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
ARG FFMPEG_VERSION=n8.1.2
RUN git clone --depth 1 --branch ${FFMPEG_VERSION} https://github.com/FFmpeg/FFmpeg.git /opt/FFmpeg

# Build script
COPY build-ffmpeg.sh /opt/build-ffmpeg.sh
RUN chmod +x /opt/build-ffmpeg.sh

ENV FFMPEG_SRC=/opt/FFmpeg

CMD ["/opt/build-ffmpeg.sh"]
