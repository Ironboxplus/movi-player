/**
 * HttpSource failure/recovery behaviour, over real TCP.
 *
 * Every fixture here is a real `node:http` server on 127.0.0.1 serving real
 * bytes; undici's global fetch talks to a real socket. Nothing about fetch,
 * the reader, the timers or the decoder is faked — the failures are produced
 * the way the network produces them (a destroyed socket mid-body, a 503, a
 * 403 on every Range, a 416 past EOF).
 *
 * ONE path here is genuinely unreachable from node and is NOT covered: the
 * CORS classifier at HttpSource's `consecutiveOnlineFetchFailures` gate keys
 * off `TypeError: Failed to fetch`, which is the browser's wording. undici
 * throws `TypeError: fetch failed`, so the branch cannot be entered without
 * substituting a fake fetch — which would make the test assert nothing about
 * the real transport. Left uncovered on purpose rather than mocked.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { HttpSource } from "../../src/source/HttpSource";
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
  vi.unstubAllGlobals();
});

/**
 * Give the module the browser worker global it reaches for.
 *
 * `self` is not a mock of anything HttpSource does — it is the environment the
 * code was written against, the same way the existing suites hand it `window`.
 * A real EventTarget is used so `addEventListener("online", …)` and the
 * dispatch below are the genuine DOM-event mechanism, not a callback registry
 * we control; and `navigator.onLine` is a real property the source reads.
 */
function stubSelf(onLine: boolean): EventTarget & { navigator: { onLine: boolean } } {
  const target = Object.assign(new EventTarget(), {
    navigator: { onLine },
  });
  vi.stubGlobal("self", target);
  return target;
}

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

function bytesOf(buf: ArrayBuffer): Uint8Array {
  return new Uint8Array(buf);
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Condition did not become true within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ─── Truncated responses: the retry loop, for real ─────────────────────────

describe("HttpSource stream retry", () => {
  it("recovers from a socket destroyed mid-body and still serves the whole file", async () => {
    const payload = makePayload(512 * 1024);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "normal",
      // The first two GETs die after 32 KiB; the third is served in full.
      abortBodyAfterBytes: 32 * 1024,
      abortBodyForFirstGets: 2,
    });
    const source = openSource(fixture.url);

    expect(await source.getSize()).toBe(payload.length);

    // Ask for four times what the server is willing to send before it hangs
    // up, so the read CANNOT be satisfied without the loop reconnecting.
    const span = bytesOf(await source.read(0, 128 * 1024));
    expect(Buffer.from(span).equals(payload.subarray(0, 128 * 1024))).toBe(true);

    // More than one body GET was needed, which is the retry actually happening.
    const bodyGets = fixture.requests.filter(
      (r) => r.method === "GET" && r.status === 206,
    );
    expect(bodyGets.length).toBeGreaterThan(1);
    // A recovered stream is not a fatal one.
    expect(source.getFatalError()).toBeNull();
  }, 60_000);

  it("retries through a transient 503 rather than failing the read", async () => {
    const payload = makePayload(256 * 1024);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "normal",
      // First body GET after size resolution is refused once.
      getFailStatuses: [503],
    });
    const source = openSource(fixture.url);

    const head = bytesOf(await source.read(0, 8192));
    expect(Buffer.from(head).equals(payload.subarray(0, 8192))).toBe(true);
    expect(fixture.requests.some((r) => r.status === 503)).toBe(true);
    expect(source.getFatalError()).toBeNull();
  }, 60_000);
});

// ─── Connectivity loss ─────────────────────────────────────────────────────

describe("HttpSource while the browser reports no connection", () => {
  it("parks on the offline signal instead of burning retries, and resumes on 'online'", async () => {
    const selfTarget = stubSelf(false); // offline before the first byte moves
    const payload = makePayload(512 * 1024);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "normal",
      abortBodyAfterBytes: 16 * 1024,
      abortBodyForFirstGets: 1,
    });
    const source = openSource(fixture.url);

    expect(await source.getSize()).toBe(payload.length);

    // Read past the truncation point. The first body GET dies at 16 KiB; the
    // loop then finds navigator.onLine false and parks rather than spending a
    // retry on a link the browser says is down.
    const readPromise = source.read(0, 128 * 1024);

    // Come back online for real: flip the property the source reads, then
    // dispatch the actual DOM event it listens for. Repeated because the park
    // is entered asynchronously — only the dispatch that lands inside the wait
    // matters, and the others are no-ops with no listener attached.
    const reconnect = setInterval(() => {
      selfTarget.navigator.onLine = true;
      selfTarget.dispatchEvent(new Event("online"));
    }, 100);

    try {
      const span = bytesOf(await readPromise);
      expect(Buffer.from(span).equals(payload.subarray(0, 128 * 1024))).toBe(
        true,
      );
    } finally {
      clearInterval(reconnect);
    }

    // Parking is not failing.
    expect(source.getFatalError()).toBeNull();
    // The 30s offline timeout must NOT have been what freed it.
    expect(
      fixture.requests.filter((r) => r.method === "GET" && r.status === 206)
        .length,
    ).toBeGreaterThan(1);
  }, 60_000);

  it("cuts the retry backoff short when the connection comes back", async () => {
    // Online throughout, so the failure takes the ordinary backoff path — and
    // an 'online' event during that backoff should end the wait early.
    const selfTarget = stubSelf(true);
    const payload = makePayload(512 * 1024);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "normal",
      abortBodyAfterBytes: 16 * 1024,
      abortBodyForFirstGets: 1,
    });
    const source = openSource(fixture.url);

    expect(await source.getSize()).toBe(payload.length);

    const startedAt = Date.now();
    const readPromise = source.read(0, 128 * 1024);
    const nudge = setInterval(
      () => selfTarget.dispatchEvent(new Event("online")),
      50,
    );

    try {
      const span = bytesOf(await readPromise);
      expect(Buffer.from(span).equals(payload.subarray(0, 128 * 1024))).toBe(
        true,
      );
    } finally {
      clearInterval(nudge);
    }

    // First backoff is ~1.5s; an online event during it should beat that.
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(source.getFatalError()).toBeNull();
  }, 60_000);
});

// ─── A link that hangs rather than resets ──────────────────────────────────

describe("HttpSource read-stall watchdog, end to end", () => {
  it("reconnects from the frontier when the body goes silent mid-transfer", async () => {
    const payload = makePayload(512 * 1024);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "normal",
      // Real silence: headers, 16 KiB, then nothing for longer than the 6s
      // watchdog, with the socket still open the whole time.
      stallAfterBytes: 16 * 1024,
      stallMs: 12_000,
      stallForFirstGets: 1,
    });
    const source = openSource(fixture.url);

    expect(await source.getSize()).toBe(payload.length);

    const span = bytesOf(await source.read(0, 128 * 1024));
    expect(Buffer.from(span).equals(payload.subarray(0, 128 * 1024))).toBe(true);

    // The watchdog is what noticed — a silent socket produces no error event.
    const stats = source.getNetworkStats();
    expect(stats.readStalls).toBeGreaterThan(0);
    // …and the reconnect resumed rather than restarting from zero.
    expect(
      fixture.requests.filter((r) => r.method === "GET" && r.status === 206)
        .length,
    ).toBeGreaterThan(1);
    expect(source.getFatalError()).toBeNull();
  }, 120_000);
});

// ─── Range refused outright ────────────────────────────────────────────────

describe("HttpSource without usable Range support", () => {
  it("falls back to a single full-body GET and serves random access from cache", async () => {
    // Small enough to fit the cache, so the whole file lands in memory and
    // seeking backwards keeps working with no second request.
    const payload = makePayload(200 * 1024);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "ignore",
    });
    const source = openSource(fixture.url, 8);

    expect(await source.getSize()).toBe(payload.length);

    // Playback opens at byte 0. The server answers 200-with-everything, which
    // is the only offset at which that answer is usable, and the file is small
    // enough to keep — so this one response becomes full random access.
    const head = bytesOf(await source.read(0, 4096));
    expect(Buffer.from(head).equals(payload.subarray(0, 4096))).toBe(true);

    await waitUntil(() => source.isFullyCached());
    expect(source.getBufferedStart()).toBe(0);
    expect(source.getBufferedEnd()).toBe(payload.length);
    expect(source.isLinearMode()).toBe(false);

    // A seek that would need a Range must now be answered from memory instead.
    const requestsBefore = fixture.requests.length;
    const mid = bytesOf(await source.read(100 * 1024, 4096));
    expect(
      Buffer.from(mid).equals(payload.subarray(100 * 1024, 100 * 1024 + 4096)),
    ).toBe(true);
    expect(fixture.requests.length).toBe(requestsBefore);
  }, 60_000);

  it("latches a fatal error when every Range is refused, instead of looking like EOF", async () => {
    const payload = makePayload(128 * 1024);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "all-forbidden",
    });
    const source = openSource(fixture.url);

    // Size still resolves — HEAD is not a Range request.
    expect(await source.getSize()).toBe(payload.length);

    // Bounded AND open-ended are both refused, so there is no chunking scheme
    // left to try. The point of the latch is that the demuxer, which can only
    // observe "no bytes", can still tell this apart from the end of the file.
    await expect(source.read(0, 4096)).rejects.toThrow(/403/);
    expect(fixture.requests.some((r) => r.status === 403)).toBe(true);

    const fatal = source.getFatalError();
    expect(fatal).toBeInstanceOf(Error);
    expect(fatal!.message).toMatch(/403/);
    // Never the URL: these carry signed query strings in production.
    expect(fatal!.message).not.toContain(fixture.url);
  }, 60_000);
});

// ─── Unsatisfiable range ───────────────────────────────────────────────────

describe("HttpSource at and beyond EOF", () => {
  it("treats a real 416 past the end as EOF, not as a fatal failure", async () => {
    const payload = makePayload(64 * 1024);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "normal",
      strict416: true,
    });
    const source = openSource(fixture.url);

    const size = await source.getSize();
    expect(size).toBe(payload.length);

    // A read that starts at EOF comes back empty — which is what the demuxer's
    // C callback means by EOF — and must NOT poison the source, because the
    // tail is probed routinely (Matroska cues, a trailing moov).
    const past = await source.read(size, 1024);
    expect(past.byteLength).toBe(0);
    expect(source.getFatalError()).toBeNull();

    // …and the source is still usable afterwards.
    const head = bytesOf(await source.read(0, 2048));
    expect(Buffer.from(head).equals(payload.subarray(0, 2048))).toBe(true);
  }, 60_000);
});

// ─── Window movement ───────────────────────────────────────────────────────

describe("HttpSource streaming window", () => {
  it("slides the window forward across a long linear read instead of growing", async () => {
    // 6 MiB of real body through a 1 MiB cache: the window has to move.
    const payload = makePayload(6 * 1024 * 1024);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "normal",
      responseChunkBytes: 64 * 1024,
    });
    const source = openSource(fixture.url, 1);

    expect(await source.getSize()).toBe(payload.length);

    for (let offset = 0; offset < payload.length; offset += 512 * 1024) {
      const length = Math.min(64 * 1024, payload.length - offset);
      const chunk = bytesOf(await source.read(offset, length));
      expect(
        Buffer.from(chunk).equals(payload.subarray(offset, offset + length)),
      ).toBe(true);
    }

    // The window moved with the playhead rather than holding byte 0.
    expect(source.getBufferedStart()).toBeGreaterThan(0);
    expect(source.isFullyCached()).toBe(false);
    const stats = source.getNetworkStats();
    expect(stats.totalBytes).toBeGreaterThan(0);
    // A healthy linear read must not have been rescued by the stall watchdog.
    expect(stats.readStalls).toBe(0);
  }, 120_000);

  it("honours a smaller opening range for split audio", async () => {
    const payload = makePayload(2 * 1024 * 1024);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "normal",
    });
    const source = openSource(fixture.url);
    // The split-audio path asks for a smaller first chunk than video's 4MB.
    source.setFirstRangeBytes(64 * 1024);

    expect(await source.getSize()).toBe(payload.length);
    const head = bytesOf(await source.read(0, 1024));
    expect(Buffer.from(head).equals(payload.subarray(0, 1024))).toBe(true);

    const firstBodyRange = fixture.requests.find(
      (r) => r.method === "GET" && r.status === 206 && r.range,
    )?.range;
    expect(firstBodyRange).toBeTruthy();
    const match = /^bytes=(\d+)-(\d*)$/.exec(firstBodyRange!);
    expect(match).toBeTruthy();
    if (match && match[2]) {
      // Bounded, and bounded by what we asked for — not the 4MB default.
      expect(parseInt(match[2], 10) - parseInt(match[1], 10) + 1).toBeLessThanOrEqual(
        64 * 1024,
      );
    }
  }, 60_000);
});

// ─── A stream that is up but delivering nothing ────────────────────────────

describe("HttpSource force restart", () => {
  it("restarts a live-but-starved stream when the reader waits out the progress timeout", async () => {
    const payload = makePayload(4 * 1024 * 1024);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "normal",
      // GET #1 (the opening chunk) is served normally, so a stream is genuinely
      // RUNNING and the next read is "covered" by it. Every reconnect after
      // that answers with headers and then nothing, for longer than
      // waitForData's 15s no-progress limit — including the reconnects the 6s
      // read-stall watchdog makes, so the watchdog alone cannot rescue it. The
      // sockets stay open: the reader is not failing, it is never fed.
      stallAfterBytes: 0,
      stallMs: 30_000,
      stallFromGet: 2,
      stallForFirstGets: 6,
    });
    const source = openSource(fixture.url);
    source.setFirstRangeBytes(128 * 1024); // small opening chunk → reconnects

    expect(await source.getSize()).toBe(payload.length);

    // Establishes the stream and leaves it running.
    const head = bytesOf(await source.read(0, 4096));
    expect(Buffer.from(head).equals(payload.subarray(0, 4096))).toBe(true);

    // Now ask for bytes just past the opening chunk: inside the window, so the
    // read waits on the running stream rather than starting its own.
    const startedAt = Date.now();
    const later = bytesOf(await source.read(160 * 1024, 4096));
    expect(
      Buffer.from(later).equals(payload.subarray(160 * 1024, 160 * 1024 + 4096)),
    ).toBe(true);

    // It cannot have come from the starved connection — that one is still
    // holding its silence — so only the reader-side restart can have served it.
    expect(Date.now() - startedAt).toBeGreaterThan(14_000);
    expect(source.getFatalError()).toBeNull();
  }, 180_000);
});

// ─── Size resolution when the first attempts fail ──────────────────────────

describe("HttpSource size resolution", () => {
  it("retries the whole attempt after HEAD, ranged GET and plain GET all fail", async () => {
    const payload = makePayload(96 * 1024);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "normal",
      rejectHead: true, // HEAD destroys the socket, as some CDNs do
      // …and the two GET fallbacks the first attempt tries are refused too, so
      // only the outer retry can produce a size.
      getFailStatuses: [500, 500],
    });
    const source = openSource(fixture.url);

    expect(await source.getSize()).toBe(payload.length);
    expect(fixture.requests.filter((r) => r.status === 500).length).toBe(2);
    expect(fixture.requests.filter((r) => r.method === "HEAD").length).toBeGreaterThan(
      0,
    );
  }, 60_000);

  it("recovers the total size from Content-Range when HEAD omits Content-Length", async () => {
    const payload = makePayload(48 * 1024);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "normal",
      headNoContentLength: true,
    });
    const source = openSource(fixture.url);

    expect(await source.getSize()).toBe(payload.length);
    // The size can only have come from a 206's Content-Range total.
    expect(
      fixture.requests.some((r) => r.method === "GET" && r.status === 206),
    ).toBe(true);
  }, 60_000);
});

// ─── Synchronous accessors ─────────────────────────────────────────────────

describe("HttpSource synchronous accessors", () => {
  it("reports the size only once it is actually known", async () => {
    const payload = makePayload(32 * 1024);
    const fixture = await openFixture({ body: payload, rangePolicy: "normal" });
    const source = openSource(fixture.url);

    // Nothing has been asked of the network yet: -1 is "not known", which is
    // deliberately distinguishable from a real zero-length file.
    expect(source.getKnownSize()).toBe(-1);
    expect(source.getBufferedStart()).toBe(0);
    expect(source.getUrl()).toBe(fixture.url);

    await source.getSize();
    expect(source.getKnownSize()).toBe(payload.length);
  }, 60_000);

  it("exposes the download filename from Content-Disposition", async () => {
    const payload = makePayload(16 * 1024);
    const fixture = await openFixture({
      body: payload,
      rangePolicy: "normal",
      contentDisposition: 'attachment; filename="Some Movie.mkv"',
    });
    const source = openSource(fixture.url);

    await source.getSize();
    expect(source.getContentDispositionFilename()).toBe("Some Movie.mkv");
  }, 60_000);
});
