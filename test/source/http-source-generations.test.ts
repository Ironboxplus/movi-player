/**
 * Per-generation byte accounting in getNetworkStats().
 *
 * The black-box byte budget is kept per stream generation, so the source has
 * to say which generation each downloaded byte belongs to. Real node:http
 * server, real fetch; the second generation is opened by the same path a seek
 * outside the window takes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { HttpSource } from "../../src/source/HttpSource";
import {
  makePayload,
  startHttpFixture,
  type HttpFixture,
} from "./http-test-server";

const fixtures: HttpFixture[] = [];
const sources: HttpSource[] = [];

afterEach(async () => {
  for (const s of sources.splice(0)) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  for (const f of fixtures.splice(0)) await f.close();
});

async function openSource(payloadBytes: number): Promise<HttpSource> {
  const fixture = await startHttpFixture({
    body: makePayload(payloadBytes),
    rangePolicy: "normal",
    responseChunkBytes: 256 * 1024,
  });
  fixtures.push(fixture);
  const source = new HttpSource(fixture.url, {}, 8);
  sources.push(source);
  expect(await source.getSize()).toBe(payloadBytes);
  return source;
}

const MIB = 1024 * 1024;

describe("HttpSource per-generation byte accounting", () => {
  it("charges each stream's bytes to its own generation", async () => {
    const source = await openSource(48 * MIB);
    await source.read(0, 64 * 1024);

    // Two small out-of-window reads are served one-off; the third is the real
    // seek that replaces the stream.
    for (const ratio of [0.2, 0.3]) {
      await source.read(Math.floor(48 * MIB * ratio), 64 * 1024);
    }
    const target = Math.floor(48 * MIB * 0.6);
    await source.read(target, 64 * 1024);

    const stats = source.getNetworkStats();
    expect(stats.generationBytes).toHaveLength(2);
    const [first, second] = stats.generationBytes;
    expect(first.startOffset).toBe(0);
    expect(second.startOffset).toBe(target);
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(first.bytes).toBeGreaterThan(0);
    expect(second.bytes).toBeGreaterThan(0);
    expect(first.bytes + second.bytes + stats.oneOff.bytes).toBe(stats.totalBytes);
    expect(stats.streamWindowBytes).toBeGreaterThan(0);
  }, 60_000);

  it("advances consumedEnd with the reads the generation serves", async () => {
    const source = await openSource(24 * MIB);
    await source.read(0, 64 * 1024);
    expect(source.getNetworkStats().generationBytes[0].consumedEnd).toBe(64 * 1024);

    // A forward jump inside the same window moves it by the whole jump.
    await source.read(3 * MIB / 2, 64 * 1024);
    expect(source.getNetworkStats().generationBytes[0].consumedEnd).toBe(
      3 * MIB / 2 + 64 * 1024,
    );

    // Reading behind the farthest point does not pull it back.
    await source.read(MIB / 2, 4096);
    expect(source.getNetworkStats().generationBytes[0].consumedEnd).toBe(
      3 * MIB / 2 + 64 * 1024,
    );
  }, 60_000);

  it("counts one-off range reads on their own and in the total", async () => {
    const source = await openSource(48 * MIB);
    await source.read(0, 64 * 1024);
    expect(source.getNetworkStats().oneOff).toEqual({
      fetches: 0,
      requestedBytes: 0,
      bytes: 0,
    });

    const probe = 64 * 1024;
    await source.read(Math.floor(48 * MIB * 0.4), probe);
    const after = source.getNetworkStats();
    expect(after.oneOff.fetches).toBe(1);
    expect(after.oneOff.requestedBytes).toBe(probe);
    expect(after.oneOff.bytes).toBe(probe);
    expect(after.generationBytes).toHaveLength(1);
    const generationSum = after.generationBytes.reduce((n, g) => n + g.bytes, 0);
    expect(generationSum + after.oneOff.bytes).toBe(after.totalBytes);
  }, 60_000);

  it("keeps only the newest 64 generations", async () => {
    const source = await openSource(8 * MIB);
    await source.read(0, 4096);
    const start = (offset: number) =>
      (source as unknown as { startStream(o: number): Promise<void> }).startStream(
        offset,
      );
    for (let i = 1; i <= 70; i++) await start(i * 4096);

    const { generationBytes } = source.getNetworkStats();
    expect(generationBytes).toHaveLength(64);
    expect(generationBytes[generationBytes.length - 1].startOffset).toBe(
      70 * 4096,
    );
    expect(generationBytes[0].startOffset).toBe(7 * 4096);
  }, 60_000);
});
