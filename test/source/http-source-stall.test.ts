import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpSource } from "../../src/source/HttpSource";

// Unit coverage for the background-download read-stall watchdog
// (readChunkWithStallTimeout). The real bug it fixes: a silent-but-open
// connection makes `await reader.read()` hang forever, so the download loop can
// neither slide the window nor reconnect and the forward runway drains to zero.
// READ_STALL_TIMEOUT_MS is 6000ms — driven here with fake timers.
describe("HttpSource read-stall watchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const makeSource = () => new HttpSource("https://example.test/video.mkv");

  it("returns null when a read delivers nothing within the stall window", async () => {
    const source: any = makeSource();
    // A silent-but-open connection: read() never settles.
    source.reader = {
      read: () => new Promise(() => {}),
      cancel: () => Promise.resolve(),
    };
    const p = source.readChunkWithStallTimeout();
    await vi.advanceTimersByTimeAsync(6000);
    await expect(p).resolves.toBeNull();
  });

  it("returns the chunk when data arrives before the stall window", async () => {
    const source: any = makeSource();
    const chunk = { done: false, value: new Uint8Array([1, 2, 3]) };
    source.reader = {
      read: () => Promise.resolve(chunk),
      cancel: () => Promise.resolve(),
    };
    const p = source.readChunkWithStallTimeout();
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe(chunk);
  });

  it("does not false-trip a slow-but-alive read that settles just in time", async () => {
    const source: any = makeSource();
    const chunk = { done: false, value: new Uint8Array([9]) };
    source.reader = {
      // Alive but slow: a chunk lands at 5s, inside the 6s window.
      read: () =>
        new Promise((resolve) => setTimeout(() => resolve(chunk), 5000)),
      cancel: () => Promise.resolve(),
    };
    const p = source.readChunkWithStallTimeout();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBe(chunk);
  });

  it("does not report an unhandled rejection when the watchdog wins and the read later rejects", async () => {
    const source: any = makeSource();
    let rejectRead: (e: Error) => void = () => {};
    source.reader = {
      read: () => new Promise((_, reject) => (rejectRead = reject)),
      cancel: () => Promise.resolve(),
    };
    const p = source.readChunkWithStallTimeout();
    await vi.advanceTimersByTimeAsync(6000);
    await expect(p).resolves.toBeNull();
    // Simulate the caller cancelling the reader afterwards, which rejects the
    // dangling read(). The separate no-op .catch must absorb it.
    expect(() => rejectRead(new Error("reader cancelled"))).not.toThrow();
    await Promise.resolve();
  });

  it("treats a missing reader as end-of-stream", async () => {
    const source: any = makeSource();
    source.reader = null;
    await expect(source.readChunkWithStallTimeout()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});
