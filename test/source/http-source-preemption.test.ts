/**
 * M1 — reads must be interruptible, and the one-off range fetch must be bounded.
 *
 * Serializing the demuxer's WASM entry points (`e55ead6`) made seek queue behind
 * an in-flight read. That is only safe if a read is bounded, and it was not:
 *
 *  - The sequential stream has the 6s read-stall watchdog and waitForData's 15s
 *    no-progress limit, so a DEAD link is bounded. That part was fine.
 *  - waitForData deliberately extends its deadline for as long as bytes keep
 *    arriving. Unbounded on purpose — a slow but steady link is worth waiting
 *    out — and left alone here.
 *  - The one-off range fetch had NO timeout at all. It carried only
 *    `lifetimeAbort`, which lives as long as the source, and `arrayBuffer()`
 *    after it carried nothing. A server that completes the handshake and then
 *    says nothing hung it forever.
 *
 * Everything below runs against a real `node:http` server on 127.0.0.1 through
 * undici's global fetch. No fetch mocks, no fake timers, no reader stubs — the
 * silence is real socket silence.
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

async function openFixture(
  opts: Parameters<typeof startHttpFixture>[0],
): Promise<HttpFixture> {
  const f = await startHttpFixture(opts);
  fixtures.push(f);
  return f;
}

function openSource(url: string, maxBufferSizeMB = 8): HttpSource {
  const s = new HttpSource(url, {}, maxBufferSizeMB);
  sources.push(s);
  return s;
}

const MIB = 1024 * 1024;

describe("HttpSource one-off range fetch is bounded", () => {
  it("gives up on a request that is accepted and then answered with silence", async () => {
    const payload = makePayload(24 * MIB);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "normal",
      // The sequential stream from byte 0 is served normally. Only the far
      // out-of-window request — the one-off — gets headers and then nothing,
      // with the socket held open. `stallMatchLimit: 1` lets the stream restart
      // that follows the abort succeed, so the test measures the one-off's
      // ceiling rather than the whole recovery chain.
      stallAfterBytes: 0,
      stallMs: 120_000,
      stallRangeStartAtLeast: 20 * MIB,
      stallMatchLimit: 1,
      responseChunkBytes: 256 * 1024,
    });
    const source = openSource(fixture.url);

    expect(await source.getSize()).toBe(payload.length);

    // Establish the sequential stream at byte 0 and leave it running.
    await source.read(0, 4096);

    // Now read 20 MiB ahead: past the window and more than the 2 MiB gap
    // threshold, so this is served as a one-off range fetch while the main
    // stream keeps going. That is the request the server stalls.
    const startedAt = Date.now();
    const far = new Uint8Array(await source.read(20 * MIB, 4096));
    const elapsed = Date.now() - startedAt;

    expect(Buffer.from(far).equals(payload.subarray(20 * MIB, 20 * MIB + 4096))).toBe(
      true,
    );
    // The stalled one-off cannot have produced these bytes — it is still
    // holding its silence. Only the timeout, followed by the stream restart,
    // can have. Before the timeout existed this call never returned at all.
    expect(elapsed).toBeGreaterThan(14_000);
    expect(elapsed).toBeLessThan(45_000);
    expect(source.getFatalError()).toBeNull();
  }, 120_000);
});

describe("HttpSource read preemption", () => {
  it("abandons a parked read when a queued seek asks for the source", async () => {
    const payload = makePayload(8 * MIB);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "normal",
      // Serve the opening chunk, then answer every reconnect with silence, so
      // a read that lands inside the stream window genuinely parks.
      stallAfterBytes: 0,
      stallMs: 120_000,
      stallFromGet: 2,
      responseChunkBytes: 64 * 1024,
    });
    const source = openSource(fixture.url);
    source.setFirstRangeBytes(128 * 1024);

    expect(await source.getSize()).toBe(payload.length);
    await source.read(0, 4096);

    // Just past the opening chunk: inside the window, so this waits on the
    // running stream. The stream is being fed nothing, so without a way to cut
    // it short this wait runs to waitForData's 15s no-progress limit and then
    // spends three force restarts on top.
    const startedAt = Date.now();
    const parked = source.read(160 * 1024, 4096);
    const outcome = parked.then(
      () => "resolved" as const,
      (e: Error) => e,
    );

    // Let it actually reach the park before signalling.
    await new Promise((r) => setTimeout(r, 500));
    source.preemptPendingReads();

    const result = await outcome;
    const elapsed = Date.now() - startedAt;

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/preempted/i);
    // The whole point: the seek behind this read waits well under a second
    // instead of the 15s+ the stall path would have cost.
    expect(elapsed).toBeLessThan(3_000);
    // A preemption is not a source failure — the next read must still work.
    expect(source.getFatalError()).toBeNull();
  }, 120_000);

  it("does not preempt a read that started after the signal", async () => {
    const payload = makePayload(2 * MIB);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "normal",
      responseChunkBytes: 64 * 1024,
    });
    const source = openSource(fixture.url);

    expect(await source.getSize()).toBe(payload.length);

    // Raise the signal with nothing in flight, then read. Reads snapshot the
    // epoch on entry, so this one must be unaffected — otherwise the seek that
    // asked for the preemption would immediately starve its own reads.
    source.preemptPendingReads();
    const head = new Uint8Array(await source.read(0, 8192));
    expect(Buffer.from(head).equals(payload.subarray(0, 8192))).toBe(true);
    expect(source.getFatalError()).toBeNull();
  }, 60_000);
});
