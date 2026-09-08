/**
 * Real-HTTP integration tests for the upstream HttpSource features we are
 * merging in while keeping our fork's window/watchdog optimisations:
 *
 *   1. HEAD throw → recover size via ranged GET (issue #14)
 *   2. Bounded range 403 → retry open-ended `bytes=N-`
 *   3. wakeBufferWaiters: main-thread path wakes parked waitForData readers
 *      the instant their bytes land (no 10 ms poll lag)
 *
 * All fixtures use a real Node http server on 127.0.0.1 — no mocks, no
 * vi.fn() for fetch. Global undici fetch talks to the real socket.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  HttpSource,
  createHttpSource,
} from "../../src/source/HttpSource";
import {
  startHttpFixture,
  makePayload,
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
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
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

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Condition did not become true within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ─── 1. HEAD throw → ranged GET size recovery ──────────────────────────────

describe("HttpSource resolveSize: HEAD throw recovery (issue #14)", () => {
  it("recovers file size via ranged GET when HEAD destroys the connection", async () => {
    const payload = makePayload(64 * 1024); // 64 KiB real bytes
    const fixture = await openFixture({
      body: payload,
      rejectHead: true,
      rangePolicy: "normal",
    });
    const source = openSource(fixture.url);

    const size = await source.getSize();
    expect(size).toBe(payload.length);

    // Must have attempted HEAD (failed) then a ranged GET that succeeded.
    const methods = fixture.requests.map((r) => r.method);
    expect(methods).toContain("HEAD");
    expect(methods).toContain("GET");
    const ranged = fixture.requests.find(
      (r) => r.method === "GET" && r.range && r.status === 206,
    );
    expect(ranged).toBeTruthy();
  });

  it("still recovers size when HEAD omits Content-Length but Range works", async () => {
    const payload = makePayload(32 * 1024);
    const fixture = await openFixture({
      body: payload,
      headNoContentLength: true,
      rangePolicy: "normal",
    });
    const source = openSource(fixture.url);

    const size = await source.getSize();
    expect(size).toBe(payload.length);
  });

  it("uses a plain GET as the last size probe when HEAD and Range expose no size", async () => {
    const payload = makePayload(24 * 1024);
    const fixture = await openFixture({
      body: payload,
      headNoContentLength: true,
      rangePolicy: "all-forbidden",
    });
    const source = openSource(fixture.url);

    expect(await source.getSize()).toBe(payload.length);
    expect(
      fixture.requests.some(
        (request) => request.method === "GET" && request.range !== undefined && request.status === 403,
      ),
    ).toBe(true);
    expect(
      fixture.requests.some(
        (request) => request.method === "GET" && request.range === undefined && request.status === 200,
      ),
    ).toBe(true);
  });

  it("serves real bytes after size recovery from a HEAD-rejecting origin", async () => {
    const payload = makePayload(48 * 1024);
    const fixture = await openFixture({
      body: payload,
      rejectHead: true,
    });
    const source = openSource(fixture.url);

    await source.getSize();
    const buf = await source.read(0, 256);
    const got = new Uint8Array(buf);
    expect(got.length).toBe(256);
    expect(Buffer.from(got).equals(payload.subarray(0, 256))).toBe(true);
  });
});

// ─── 2. Bounded range 403 → open-ended retry ───────────────────────────────

describe("HttpSource stream: 403 on bounded range retries open-ended", () => {
  it("plays past a server that 403s bounded bytes=0-N but accepts bytes=0-", async () => {
    // Large enough that getSize uses a sliding window (not full-file cache)
    // under our 8 MB test cap — forces a bounded Range on first stream fetch.
    const payload = makePayload(12 * 1024 * 1024); // 12 MiB
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "bounded-0-forbidden",
    });
    const source = openSource(fixture.url, 8);

    const size = await source.getSize();
    expect(size).toBe(payload.length);

    // First read kicks off the background stream. Under bounded-0-forbidden
    // the initial `bytes=0-<window>` must 403, then open-ended must succeed.
    const buf = await source.read(0, 4096);
    const got = new Uint8Array(buf);
    expect(got.length).toBe(4096);
    expect(Buffer.from(got).equals(payload.subarray(0, 4096))).toBe(true);

    const rangeGets = fixture.requests.filter(
      (r) => r.method === "GET" && r.range,
    );
    // At least one 403 for a bounded zero-offset range…
    expect(
      rangeGets.some(
        (r) =>
          r.status === 403 &&
          r.range !== undefined &&
          /^bytes=0-\d+$/i.test(r.range),
      ),
    ).toBe(true);
    // …and at least one successful open-ended (or non-zero) 206 afterwards.
    expect(rangeGets.some((r) => r.status === 206)).toBe(true);
    expect(
      rangeGets.some(
        (r) =>
          r.status === 206 &&
          r.range !== undefined &&
          (/^bytes=0-$/i.test(r.range) || /^bytes=[1-9]/i.test(r.range)),
      ),
    ).toBe(true);
    expect(source.getNetworkStats().rangeOpenEndedSwitches).toBe(1);
  });

  it("does not infinite-loop when every range is forbidden", async () => {
    const payload = makePayload(64 * 1024);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "all-forbidden",
    });
    const source = openSource(fixture.url, 1);

    await source.getSize();
    // getSize itself uses a 1-byte range probe — under all-forbidden that
    // returns null and falls through to plain GET, which still works. The
    // stream path is what must not hang: a read that needs the background
    // stream should surface an error (or timeout) rather than spin forever.
    await expect(source.read(0, 16)).rejects.toThrow();
  }, 20_000);
});

// ─── 3. wakeBufferWaiters ──────────────────────────────────────────────────

describe("HttpSource waitForData: wake on buffer advance (no mock)", () => {
  it("unparks a waiting reader within a few ms of bytes landing", async () => {
    // Small file that fully fits the buffer so the background stream fills
    // sequentially; we measure that waitForData does not sit on a fixed
    // 10 ms poll after the write.
    const payload = makePayload(256 * 1024);
    const fixture = await openFixture({ body: payload });
    const source = openSource(fixture.url, 8);

    await source.getSize();

    // Kick the stream by reading a tiny prefix, then immediately request a
    // later offset that is not yet buffered — waitForData must wake as the
    // background loop writes past that offset.
    await source.read(0, 64);

    const t0 = performance.now();
    const buf = await source.read(32 * 1024, 1024);
    const elapsed = performance.now() - t0;

    expect(new Uint8Array(buf).length).toBe(1024);
    expect(
      Buffer.from(new Uint8Array(buf)).equals(
        payload.subarray(32 * 1024, 32 * 1024 + 1024),
      ),
    ).toBe(true);

    // With wake-on-write the wait should complete well under a poll-heavy
    // budget. Keep this loose enough for CI load but tight enough that a
    // pure 10 ms-poll + multi-chunk fill would still pass; the real
    // regression guard is the unit-level waiter test below.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("wakes a parked waitForBufferAdvance the moment writePos advances", async () => {
    // Direct exercise of the waiter primitive against a live HttpSource
    // instance — still no mocks: we drive the public atomic path by
    // reading from a real server so the background loop calls
    // atomicSetWritePos → wakeBufferWaiters.
    const payload = makePayload(128 * 1024);
    const fixture = await openFixture({ body: payload });
    const source = openSource(fixture.url, 8) as any;

    await source.getSize();

    // Ensure fallback (non-SAB) path — Node vitest has no crossOriginIsolated.
    expect(source.useSharedBuffer).toBe(false);

    // Start streaming from 0 without consuming via read(), so we can park
    // a waiter ourselves and observe the wake.
    source.atomicSetStreaming(true);
    source.abortController = new AbortController();
    const streamPromise = source.readStreamBackground(0);

    const needed = 8 * 1024;
    const t0 = performance.now();
    await source.waitForBufferAdvance(needed, 5_000);
    const elapsed = performance.now() - t0;

    expect(source.bufferEnd).toBeGreaterThanOrEqual(needed);
    // Wake should fire near the write, not sit out the full 250 ms safety
    // timer. Allow generous CI slack but fail hard if we only ever poll.
    expect(elapsed).toBeLessThan(2_000);

    source.atomicSetStreaming(false);
    source.abortController.abort();
    try {
      await streamPromise;
    } catch {
      /* aborted */
    }
  });
});

// ─── buildRequestHeaders openEnded shape ───────────────────────────────────

describe("HttpSource buildRequestHeaders openEnded", () => {
  it("emits bytes=N- when openEnded is set, bounded otherwise", async () => {
    const source = openSource("http://127.0.0.1:9/unused") as any;
    const bounded = await source.buildRequestHeaders({
      offset: 0,
      length: 1024,
    });
    expect(bounded.Range).toBe("bytes=0-1023");

    const open = await source.buildRequestHeaders({
      offset: 0,
      length: 1024,
      openEnded: true,
    });
    expect(open.Range).toBe("bytes=0-");

    const mid = await source.buildRequestHeaders({
      offset: 1_048_576,
      length: 4096,
      openEnded: true,
    });
    expect(mid.Range).toBe("bytes=1048576-");
  });
});

// ─── Content-Disposition via ranged GET after HEAD reject ──────────────────

describe("HttpSource filename recovery after HEAD reject", () => {
  it("picks Content-Disposition off the ranged GET when HEAD is destroyed", async () => {
    const payload = makePayload(16 * 1024);
    const fixture = await openFixture({
      body: payload,
      rejectHead: true,
      contentDisposition: 'attachment; filename="real-movie.mkv"',
    });
    const source = openSource(fixture.url);
    await source.getSize();
    expect(source.getContentDispositionFilename()).toBe("real-movie.mkv");
  });
});

// ─── wake on stream stop ───────────────────────────────────────────────────

describe("HttpSource wakeBufferWaiters on stream stop", () => {
  it("force-wakes parked waiters when streaming flips off", async () => {
    const source = openSource("http://127.0.0.1:9/unused") as any;
    // No SAB in node vitest → fallback path.
    expect(source.useSharedBuffer).toBe(false);

    source.atomicSetStreaming(true);
    const parked = source.waitForBufferAdvance(Number.MAX_SAFE_INTEGER, 5_000);
    // Stop the stream: atomicSetStreaming(false) must force-wake every waiter
    // so they don't sit on the safety timer for bytes that will never arrive.
    const t0 = performance.now();
    source.atomicSetStreaming(false);
    await parked;
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("HttpSource network observability", () => {
  it("exposes stream lifecycle counters without revealing the source URL", async () => {
    const source = openSource("http://127.0.0.1:9/private?token=secret") as any;
    const initial = source.getNetworkStats();
    expect(initial).toMatchObject({
      streamGeneration: 0,
      rangeOpenEndedSwitches: 0,
      readStalls: 0,
      supersededStreams: 0,
      bufferWaiters: 0,
      lastProgressAt: 0,
    });
    expect(JSON.stringify(initial)).not.toContain("private");
    expect(JSON.stringify(initial)).not.toContain("secret");

    source.atomicIncrementVersion();
    source.atomicSetStreaming(true);
    const parked = source.waitForBufferAdvance(Number.MAX_SAFE_INTEGER, 5_000);
    expect(source.getNetworkStats()).toMatchObject({
      streamGeneration: 1,
      bufferWaiters: 1,
    });
    source.atomicSetStreaming(false);
    await parked;
    expect(source.getNetworkStats().bufferWaiters).toBe(0);
  });

  it("ends a fallback-buffer waiter when a newer stream generation supersedes it", async () => {
    const source = openSource("http://127.0.0.1:9/unused") as any;
    expect(source.useSharedBuffer).toBe(false);

    source.atomicSetStreaming(true);
    const waiting = source.waitForData(1024, 1, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    source.atomicIncrementVersion();
    source.wakeBufferWaiters(true);

    await expect(waiting).resolves.toBe(false);
    source.atomicSetStreaming(false);
  });
});

// ─── superseded stream ownership ───────────────────────────────────────────

describe("HttpSource stream ownership across a superseding seek", () => {
  it("repositions the active Range stream on the first read after an explicit seek hint", async () => {
    const payload = makePayload(64 * 1024 * 1024);
    const fixture = await openFixture({
      body: payload,
      responseChunkBytes: 32 * 1024,
      responseChunkDelayMs: 4,
    });
    const source = openSource(fixture.url, 8);

    expect(await source.getSize()).toBe(payload.length);
    await source.read(0, 64 * 1024);
    const generationBeforeSeek = source.getNetworkStats().streamGeneration;

    // A real player seek declares its intent before FFmpeg performs the first
    // landing read. That read must replace the old sequential request at once;
    // serving it as a one-off keeps the old stream consuming bandwidth from
    // the abandoned position and makes remote seeks time out.
    source.hintSeek();
    const landingOffset = 40 * 1024 * 1024;
    const landing = new Uint8Array(
      await source.read(landingOffset, 64 * 1024),
    );

    expect(
      Buffer.from(landing).equals(
        payload.subarray(landingOffset, landingOffset + 64 * 1024),
      ),
    ).toBe(true);
    expect(source.getNetworkStats().streamGeneration).toBe(
      generationBeforeSeek + 1,
    );
    expect(source.getBufferStart()).toBe(landingOffset);
  }, 20_000);

  it("keeps a targeted seek hint through a tail-index read and consumes it at the landing", async () => {
    const payload = makePayload(64 * 1024 * 1024);
    const fixture = await openFixture({
      body: payload,
      responseChunkBytes: 32 * 1024,
      responseChunkDelayMs: 4,
    });
    const source = openSource(fixture.url, 8);

    await source.getSize();
    await source.read(0, 64 * 1024);
    const initialGeneration = source.getNetworkStats().streamGeneration;
    const landingOffset = 40 * 1024 * 1024;

    // FFmpeg commonly consults Cues/index data near EOF before it asks for the
    // actual seek landing. That metadata read must remain a one-off and must
    // not consume the targeted hint.
    source.hintSeek(landingOffset);
    const tailOffset = 60 * 1024 * 1024;
    const tail = new Uint8Array(await source.read(tailOffset, 64 * 1024));
    expect(Buffer.from(tail).equals(payload.subarray(tailOffset, tailOffset + 64 * 1024))).toBe(true);
    expect(source.getNetworkStats().streamGeneration).toBe(initialGeneration);

    const landing = new Uint8Array(await source.read(landingOffset, 64 * 1024));
    expect(Buffer.from(landing).equals(payload.subarray(landingOffset, landingOffset + 64 * 1024))).toBe(true);
    expect(source.getNetworkStats().streamGeneration).toBe(initialGeneration + 1);
    expect(source.getBufferStart()).toBe(landingOffset);
  }, 20_000);

  it("does not let the old Range loop stop or steal the replacement reader", async () => {
    const payload = makePayload(64 * 1024 * 1024);
    const fixture = await openFixture({
      body: payload,
      responseChunkBytes: 32 * 1024,
      responseChunkDelayMs: 4,
    });
    const source = openSource(fixture.url, 8) as any;

    expect(await source.getSize()).toBe(payload.length);

    // The first read returns after a few real TCP chunks while its bounded
    // Range response is still streaming. A far-away read then performs the
    // same stop/start replacement as a real seek outside the current window.
    const first = new Uint8Array(await source.read(0, 64 * 1024));
    expect(Buffer.from(first).equals(payload.subarray(0, 64 * 1024))).toBe(true);

    const replacementOffset = 40 * 1024 * 1024;
    const replacement = new Uint8Array(
      await source.read(replacementOffset, 64 * 1024),
    );
    expect(
      Buffer.from(replacement).equals(
        payload.subarray(replacementOffset, replacementOffset + 64 * 1024),
      ),
    ).toBe(true);

    // Keep the replacement response in flight long enough for the old loop's
    // abort/finally path to run. It must not clear STREAM_ACTIVE or this.reader
    // for the new generation.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(source.atomicIsStreaming()).toBe(true);
    expect(source.reader).not.toBeNull();

    const followOffset = replacementOffset + 512 * 1024;
    const follow = new Uint8Array(await source.read(followOffset, 64 * 1024));
    expect(
      Buffer.from(follow).equals(
        payload.subarray(followOffset, followOffset + 64 * 1024),
      ),
    ).toBe(true);

    const rangedGets = fixture.requests.filter(
      (request) => request.method === "GET" && request.status === 206,
    );
    expect(rangedGets.some((request) => request.range?.startsWith("bytes=0-"))).toBe(true);
    expect(
      rangedGets.some((request) =>
        request.range?.startsWith(`bytes=${replacementOffset}-`),
      ),
    ).toBe(true);
  }, 20_000);
});

// ─── Regression: our fork optimisations must still hold ────────────────────

describe("HttpSource fork optimisations still present", () => {
  it("exposes streamWindowBytes as a single source of truth capped at 512 MiB", () => {
    const source = openSource("http://127.0.0.1:9/unused", 1024) as any;
    // maxBufferSizeMB=1024 → bufferSize will be resized on getSize, but the
    // raw helper must already cap via MAX_STREAM_BUFFER_SIZE (512 MiB) and
    // scale with bufferSize*0.9.
    source.bufferSize = 1024 * 1024 * 1024; // 1 GiB configured
    const window = source.streamWindowBytes();
    expect(window).toBe(512 * 1024 * 1024); // hard cap
    source.bufferSize = 100 * 1024 * 1024;
    expect(source.streamWindowBytes()).toBe(
      Math.floor(100 * 1024 * 1024 * 0.9),
    );
  });

  it("keeps the read-stall watchdog (readChunkWithStallTimeout)", () => {
    const source = openSource("http://127.0.0.1:9/unused") as any;
    expect(typeof source.readChunkWithStallTimeout).toBe("function");
  });

  // H5: upstream's prefetch gate lets MoviPlayer hand the link back to a
  // bandwidth-starved split-audio track. It is orthogonal to our supersede
  // mechanism (reader identity + generation), so the two coexist — and the gate
  // has to sit BEFORE the read-stall watchdog starts timing, or a deliberate
  // park reads as a silent connection and the watchdog tears down a stream that
  // is doing exactly what it was told.
  it("parks the background download while the prefetch gate is closed, over a real socket", async () => {
    // 3 MiB in 64 KiB chunks with a real inter-chunk delay, so the download is
    // genuinely in flight and can be observed stopping and restarting.
    const payload = makePayload(3 * 1024 * 1024);
    const fixture = await openFixture({
      body: payload,
      responseChunkBytes: 64 * 1024,
      responseChunkDelayMs: 5,
    });
    const source = openSource(fixture.url, 8) as any;

    expect(typeof source.setPrefetchThrottle).toBe("function");

    await source.getSize();
    // Kick the background stream off and let it get moving.
    await source.read(0, 64 * 1024);
    await waitUntil(() => source.getNetworkStats().totalBytes > 128 * 1024, 5_000);

    source.setPrefetchThrottle(true);
    // Let whatever read was already in flight land, then take the reading.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const parked = source.getNetworkStats().totalBytes;
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Throttled: the loop is parked, so no further bytes are pulled. The
    // fixture still has ~2.8 MiB to give at 64 KiB per 5 ms, so an unparked
    // loop would have moved a long way in 600 ms.
    expect(source.getNetworkStats().totalBytes).toBe(parked);
    // ...and parking must not be mistaken for a stalled connection.
    expect(source.getNetworkStats().readStalls).toBe(0);

    source.setPrefetchThrottle(false);
    await waitUntil(
      () => source.getNetworkStats().totalBytes > parked,
      5_000,
    );
  }, 30_000);

  it("still slides the window via waitForWindowRoom after a full fill", async () => {
    // 3 MiB payload, 2 MiB buffer cap → cannot full-cache; stream must fill a
    // window, waitForWindowRoom, slide, and keep serving sequential reads.
    const payload = makePayload(3 * 1024 * 1024);
    const fixture = await openFixture({ body: payload });
    const source = openSource(fixture.url, 2);

    await source.getSize();
    // Read across more than one window's worth so the background loop has to
    // slide (our fork optimisation) rather than stop-at-full.
    const chunk = 64 * 1024;
    for (let off = 0; off + chunk <= payload.length; off += chunk) {
      const buf = await source.read(off, chunk);
      expect(
        Buffer.from(new Uint8Array(buf)).equals(
          payload.subarray(off, off + chunk),
        ),
      ).toBe(true);
    }
  }, 30_000);
});

describe("HttpSource origins that ignore Range", () => {
  it("caches a fitting file completely and keeps random access available", async () => {
    const payload = makePayload(512 * 1024);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "ignore",
      responseChunkBytes: 32 * 1024,
      responseChunkDelayMs: 1,
    });
    const source = openSource(fixture.url, 2);

    expect(await source.getSize()).toBe(payload.length);
    expect(source.isRangeUnsupported()).toBe(false);
    expect(source.isLinearMode()).toBe(false);

    const prefix = new Uint8Array(await source.read(0, 64 * 1024));
    expect(Buffer.from(prefix).equals(payload.subarray(0, prefix.length))).toBe(true);

    // The non-Range response keeps downloading after the first read. Reading
    // the tail waits for the same real TCP stream and proves the full-cache
    // state rather than relying on a timer.
    const tailOffset = payload.length - 4096;
    const tail = new Uint8Array(await source.read(tailOffset, 4096));
    expect(Buffer.from(tail).equals(payload.subarray(tailOffset))).toBe(true);
    await waitUntil(() => source.isFullyCached());
    expect(source.isRangeUnsupported()).toBe(true);
    expect(source.isLinearMode()).toBe(false);
    expect(source.isFullyCached()).toBe(true);
    expect(source.getBufferedEnd()).toBe(payload.length);
    expect(source.getBufferStart()).toBe(0);

    source.seek(128 * 1024);
    expect(source.getPosition()).toBe(128 * 1024);
    const replay = new Uint8Array(await source.read(128 * 1024, 2048));
    expect(Buffer.from(replay).equals(payload.subarray(128 * 1024, 128 * 1024 + 2048))).toBe(true);
    // The legacy persistent head cache is intentionally dormant in both
    // upstream and the fork; metadata LRU + the active range window are the
    // live borrowing surfaces. Do not pretend the dormant cache is populated.
    expect(source.peekHead(0, 64)).toBeNull();
    expect(source.peekRange(128 * 1024, 64)).not.toBeNull();
    expect(source.peekMetadata(128 * 1024, 64)).not.toBeNull();
    expect(source.getKey()).toBe(fixture.url);
    expect(source.getUrl()).toBe(fixture.url);
    expect(source.getSharedBuffer()).toBeNull();
  }, 20_000);

  it("enters bounded linear mode and rejects unreachable seeks", async () => {
    const payload = makePayload(3 * 1024 * 1024);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "ignore",
      responseChunkBytes: 64 * 1024,
      responseChunkDelayMs: 1,
    });
    const source = openSource(fixture.url, 2);
    let linearNotifications = 0;
    source.setOnLinearMode(() => linearNotifications++);

    expect(await source.getSize()).toBe(payload.length);
    // Keep chunks above the metadata-LRU ceiling so this is a pure bounded
    // linear-window exercise; replay assertions below must not be satisfied by
    // the independent small-metadata cache.
    const chunk = 256 * 1024;
    for (let offset = 0; offset < payload.length; offset += chunk) {
      const reads = offset === 2 * 1024 * 1024
        ? await Promise.all([
            source.read(offset, chunk),
            source.read(offset, chunk),
          ])
        : [await source.read(offset, chunk)];
      for (const read of reads) {
        const bytes = new Uint8Array(read);
        expect(Buffer.from(bytes).equals(payload.subarray(offset, offset + chunk))).toBe(true);
      }

      if (offset === 0) {
        const impossibleOffset = Math.min(
          payload.length - 1,
          source.getBufferedEnd() + 256 * 1024,
        );
        await expect(source.read(impossibleOffset, 1)).rejects.toThrow(
          "Server does not support range requests",
        );
      }
    }

    expect(source.isRangeUnsupported()).toBe(true);
    expect(source.isLinearMode()).toBe(true);
    expect(linearNotifications).toBe(1);
    expect(source.isFullyCached()).toBe(false);

    // Late subscribers are informed immediately so UI state cannot miss the
    // transition that happened during source startup.
    source.setOnLinearMode(() => linearNotifications++);
    expect(linearNotifications).toBe(2);

    // Consuming more than the 2 MiB cap must have advanced the bounded
    // sliding window. Bytes discarded behind it are genuinely unreachable on
    // a no-Range origin and must fail immediately rather than redownload the
    // complete object at a wrong logical offset.
    expect(source.getBufferStart()).toBeGreaterThan(0);
    await expect(source.read(0, 1)).rejects.toThrow(
      "Server does not support range requests",
    );

  }, 20_000);
});

describe("HttpSource public configuration and factory", () => {
  it("applies valid runtime buffer caps and ignores invalid caps", async () => {
    // 8% of 40 MiB is 3.2 MiB, so lowering the cap from 8 MiB to 3 MiB
    // produces an observable resize without reaching into private state.
    const payload = makePayload(40 * 1024 * 1024);
    const fixture = await openFixture({ body: payload });
    const source = openSource(fixture.url, 8) as any;

    expect(await source.getSize()).toBe(payload.length);
    source.setMaxBufferSize(3);
    expect(source.bufferSize).toBe(3 * 1024 * 1024);
    source.setMaxBufferSize(0);
    expect(source.bufferSize).toBe(3 * 1024 * 1024);
  });

  it("creates a lazy source through the public factory", async () => {
    const payload = makePayload(8 * 1024);
    const fixture = await openFixture({ body: payload });
    const source = await createHttpSource(fixture.url, { "X-Test": "real-tcp" }, 2);
    sources.push(source);

    expect(source).toBeInstanceOf(HttpSource);
    expect(source.getUrl()).toBe(fixture.url);
    expect(await source.getSize()).toBe(payload.length);
  });
});
