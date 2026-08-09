import { afterEach, describe, expect, it } from "vitest";
import { HttpSource } from "../../src/source/HttpSource";
import {
  makePayload,
  startHttpFixture,
  type HttpFixture,
} from "./http-test-server";

// Real-socket coverage for the background-download read-stall watchdog. Every
// reader below comes from undici fetch over a real 127.0.0.1 TCP connection;
// there are no fake timers, fetch mocks, or reader stubs.
describe("HttpSource read-stall watchdog over real TCP", () => {
  const fixtures: HttpFixture[] = [];
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const sources: HttpSource[] = [];

  afterEach(async () => {
    for (const reader of readers.splice(0)) {
      try {
        await reader.cancel();
      } catch {
        // The peer may already have closed the real socket.
      }
    }
    for (const source of sources.splice(0)) source.close();
    for (const fixture of fixtures.splice(0)) await fixture.close();
  });

  async function openRealReader(initialDelayMs = 0) {
    const fixture = await startHttpFixture({
      body: makePayload(64 * 1024),
      responseInitialDelayMs: initialDelayMs,
    });
    fixtures.push(fixture);
    const response = await fetch(fixture.url, {
      headers: { Range: "bytes=0-65535" },
    });
    expect(response.status).toBe(206);
    expect(response.body).not.toBeNull();
    const reader = response.body!.getReader();
    readers.push(reader);
    return reader;
  }

  function sourceWith(reader: ReadableStreamDefaultReader<Uint8Array> | null) {
    const source = new HttpSource("http://127.0.0.1/real-socket") as any;
    source.reader = reader;
    sources.push(source);
    return source;
  }

  it("returns null after six seconds of a silent but open response and tolerates cancellation", async () => {
    const reader = await openRealReader(7_000);
    const source = sourceWith(reader);

    const startedAt = Date.now();
    await expect(source.readChunkWithStallTimeout()).resolves.toBeNull();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(5_800);

    // Cancelling the real pending socket read after the watchdog wins must not
    // surface an unhandled rejection from the abandoned reader.read() branch.
    await reader.cancel();
    readers.splice(readers.indexOf(reader), 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }, 10_000);

  it("returns an immediate real network chunk before the watchdog", async () => {
    const source = sourceWith(await openRealReader());
    const chunk = await source.readChunkWithStallTimeout();
    expect(chunk).not.toBeNull();
    if (!chunk) throw new Error("Expected a real response chunk");
    expect(chunk.done).toBe(false);
    expect(chunk.value?.byteLength).toBeGreaterThan(0);
  });

  it("does not false-trip a slow response whose first byte arrives at five seconds", async () => {
    const source = sourceWith(await openRealReader(5_000));
    const startedAt = Date.now();
    const chunk = await source.readChunkWithStallTimeout();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_800);
    expect(chunk).not.toBeNull();
    if (!chunk) throw new Error("Expected the delayed real response chunk");
    expect(chunk.done).toBe(false);
    expect(chunk.value?.byteLength).toBeGreaterThan(0);
  }, 9_000);

  it("treats a missing reader as end-of-stream", async () => {
    const source = sourceWith(null);
    await expect(source.readChunkWithStallTimeout()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});
