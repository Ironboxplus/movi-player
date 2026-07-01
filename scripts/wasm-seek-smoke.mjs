#!/usr/bin/env node
import { open } from "node:fs/promises";
import { resolve } from "node:path";

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function headersFromEnv() {
  const raw = process.env.MOVI_SEEK_SMOKE_HEADERS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("headers must be a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid MOVI_SEEK_SMOKE_HEADERS JSON: ${error.message}`);
  }
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
}

class NodeFileSource {
  constructor(filePath) {
    this.filePath = resolve(filePath);
    this.handle = null;
    this.position = 0;
    this.size = null;
  }

  async getHandle() {
    if (!this.handle) {
      this.handle = await open(this.filePath, "r");
    }
    return this.handle;
  }

  async getSize() {
    if (this.size === null) {
      const handle = await this.getHandle();
      this.size = (await handle.stat()).size;
    }
    return this.size;
  }

  async read(offset, length) {
    const size = await this.getSize();
    if (offset >= size || length <= 0) {
      return new ArrayBuffer(0);
    }

    const actualLength = Math.min(length, size - offset);
    const buffer = Buffer.allocUnsafe(actualLength);
    const handle = await this.getHandle();
    const { bytesRead } = await handle.read(
      buffer,
      0,
      actualLength,
      offset,
    );
    this.position = offset + bytesRead;
    return toArrayBuffer(buffer.subarray(0, bytesRead));
  }

  seek(offset) {
    this.position = Math.max(0, offset);
    return this.position;
  }

  getPosition() {
    return this.position;
  }

  close() {
    const handle = this.handle;
    this.handle = null;
    if (handle) void handle.close();
  }

  async dispose() {
    const handle = this.handle;
    this.handle = null;
    if (handle) await handle.close();
  }

  getKey() {
    return `file:${this.filePath}`;
  }
}

class NodeHttpRangeSource {
  constructor(url, headers) {
    this.url = url;
    this.headers = headers;
    this.position = 0;
    this.size = null;
  }

  async getSize() {
    if (this.size !== null) return this.size;

    const head = await fetch(this.url, {
      method: "HEAD",
      headers: this.headers,
    });
    const contentLength = Number(head.headers.get("content-length"));
    if (head.ok && Number.isFinite(contentLength) && contentLength > 0) {
      this.size = contentLength;
      return this.size;
    }

    const probe = await fetch(this.url, {
      headers: {
        ...this.headers,
        Range: "bytes=0-0",
      },
    });
    const contentRange = probe.headers.get("content-range") ?? "";
    const match = contentRange.match(/\/(\d+)$/);
    if (!match) {
      throw new Error("HTTP source did not expose Content-Length/Content-Range");
    }
    this.size = Number(match[1]);
    return this.size;
  }

  async read(offset, length) {
    const size = await this.getSize();
    if (offset >= size || length <= 0) {
      return new ArrayBuffer(0);
    }

    const end = Math.min(size - 1, offset + length - 1);
    const response = await fetch(this.url, {
      headers: {
        ...this.headers,
        Range: `bytes=${offset}-${end}`,
      },
    });
    if (response.status !== 206) {
      throw new Error(`HTTP range read failed: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    this.position = offset + buffer.byteLength;
    return buffer;
  }

  seek(offset) {
    this.position = Math.max(0, offset);
    return this.position;
  }

  getPosition() {
    return this.position;
  }

  close() {}

  async dispose() {}

  getKey() {
    return `url:${this.url}`;
  }
}

async function loadDemuxer() {
  try {
    return await import("../dist/demuxer.js");
  } catch (error) {
    throw new Error(
      `Unable to import dist/demuxer.js. Run npm run build:ts after the WASM artifact is present. Cause: ${error.message}`,
    );
  }
}

function chooseTarget(durationSeconds) {
  const requested = Number(process.env.MOVI_SEEK_TARGET_SECONDS);
  if (Number.isFinite(requested) && requested >= 0) {
    return requested;
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 0;
  }
  if (durationSeconds <= 20) {
    return Math.max(0, durationSeconds / 2);
  }
  return Math.min(durationSeconds - 5, Math.max(10, durationSeconds * 0.15));
}

function makeSource() {
  const filePath = process.env.MOVI_SEEK_SMOKE_FILE;
  const url = process.env.MOVI_SEEK_SMOKE_URL;
  if (filePath) return new NodeFileSource(filePath);
  if (url) return new NodeHttpRangeSource(url, headersFromEnv());
  return null;
}

async function main() {
  const source = makeSource();
  if (!source) {
    console.log(
      JSON.stringify({
        skipped: true,
        reason:
          "Set MOVI_SEEK_SMOKE_FILE or MOVI_SEEK_SMOKE_URL to run the WASM seek smoke test.",
      }),
    );
    return;
  }

  const { Demuxer } = await loadDemuxer();
  const demuxer = new Demuxer(source);
  const maxPackets = envNumber("MOVI_SEEK_MAX_PACKETS", 2000);
  const timeoutMs = envNumber("MOVI_SEEK_TIMEOUT_MS", 15_000);
  const maxPositiveDriftSeconds = envNumber(
    "MOVI_SEEK_MAX_POSITIVE_DRIFT_SECONDS",
    30,
  );
  const flags = envNumber("MOVI_SEEK_FLAGS", 1);

  try {
    const mediaInfo = await demuxer.open();
    const videoTrack = mediaInfo.tracks.find(
      (track) => track.type === "video" && !track.isAttachedPic,
    );
    if (!videoTrack) {
      throw new Error("No playable video track found");
    }

    const targetSeconds = chooseTarget(mediaInfo.duration);
    await demuxer.seek(targetSeconds, flags, videoTrack.id);

    const byStream = {};
    let firstVideoPacket = null;
    let firstPostTargetVideoPacket = null;
    let eof = false;
    const startedAt = performance.now();
    let packetsRead = 0;

    while (
      packetsRead < maxPackets &&
      performance.now() - startedAt < timeoutMs
    ) {
      const packet = await demuxer.readPacket();
      if (!packet) {
        eof = true;
        break;
      }

      packetsRead += 1;
      byStream[packet.streamIndex] = (byStream[packet.streamIndex] ?? 0) + 1;

      if (packet.streamIndex !== videoTrack.id) {
        continue;
      }

      const videoPacket = {
        packetNumber: packetsRead,
        timestamp: packet.timestamp,
        dts: packet.dts,
        duration: packet.duration,
        keyframe: packet.keyframe,
      };
      firstVideoPacket ??= videoPacket;
      if (
        firstPostTargetVideoPacket === null &&
        Number.isFinite(packet.timestamp) &&
        packet.timestamp >= targetSeconds
      ) {
        firstPostTargetVideoPacket = videoPacket;
      }
      if (firstPostTargetVideoPacket) {
        break;
      }
    }

    if (!firstVideoPacket) {
      throw new Error(
        `No video packet after seek(${targetSeconds}) within ${packetsRead} packets / ${timeoutMs}ms`,
      );
    }

    const positiveDrift = Number.isFinite(firstVideoPacket.timestamp)
      ? firstVideoPacket.timestamp - targetSeconds
      : 0;
    if (positiveDrift > maxPositiveDriftSeconds) {
      throw new Error(
        `First video packet landed ${positiveDrift.toFixed(3)}s after target; expected <= ${maxPositiveDriftSeconds}s`,
      );
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          source: source.getKey(),
          durationSeconds: mediaInfo.duration,
          videoStreamIndex: videoTrack.id,
          targetSeconds,
          flags,
          packetsRead,
          eof,
          elapsedMs: Math.round(performance.now() - startedAt),
          byStream,
          firstVideoPacket,
          firstPostTargetVideoPacket,
        },
        null,
        2,
      ),
    );
  } finally {
    demuxer.close();
    await source.dispose?.();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
