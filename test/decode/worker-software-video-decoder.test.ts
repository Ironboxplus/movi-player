import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerSoftwareVideoDecoder } from "../../src/decode/WorkerSoftwareVideoDecoder";
import type { VideoTrack } from "../../src/types";

class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  posts: Array<{ message: any; transfer: Transferable[] }> = [];

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: any, transfer: Transferable[] = []): void {
    this.posts.push({ message, transfer });
  }

  terminate(): void {}
}

const track: VideoTrack = {
  id: 3,
  type: "video",
  codec: "mpeg2video",
  codecId: 2,
  width: 1920,
  height: 1080,
  frameRate: 23.976,
  bitRate: 0,
  profile: 4,
  level: 4,
  pixelFormat: "yuv420p",
};

function configure(decoder: WorkerSoftwareVideoDecoder, worker: FakeWorker) {
  const promise = decoder.configure(track);
  const request = worker.posts[0].message;
  worker.onmessage?.(
    new MessageEvent("message", {
      data: {
        type: "configured",
        requestId: request.requestId,
        generation: request.generation,
        trackId: request.trackId,
        success: true,
        queueDepth: 0,
        inFlight: 0,
      },
    }),
  );
  return promise;
}

afterEach(() => {
  FakeWorker.instances = [];
  vi.unstubAllGlobals();
});

describe("WorkerSoftwareVideoDecoder protocol", () => {
  it("keeps codec configuration generic and transfers a Worker-owned packet copy", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const first = new WorkerSoftwareVideoDecoder();
    const second = new WorkerSoftwareVideoDecoder();
    const firstWorker = FakeWorker.instances[0];
    const secondWorker = FakeWorker.instances[1];
    const h264Track = {
      ...track,
      id: 4,
      codec: "h264",
      codecId: 27,
      extradata: new Uint8Array([9, 8, 7]),
    };

    const firstConfigured = first.configure(track);
    const firstRequest = firstWorker.posts[0].message;
    firstWorker.onmessage?.(
      new MessageEvent("message", {
        data: { ...firstRequest, type: "configured", success: true },
      }),
    );
    const secondConfigured = second.configure(h264Track);
    const secondRequest = secondWorker.posts[0].message;
    secondWorker.onmessage?.(
      new MessageEvent("message", {
        data: { ...secondRequest, type: "configured", success: true },
      }),
    );

    await expect(firstConfigured).resolves.toBe(true);
    await expect(secondConfigured).resolves.toBe(true);
    expect(firstRequest.codecId).toBe(2);
    expect(secondRequest.codecId).toBe(27);
    expect(Array.from(secondRequest.extradata)).toEqual([9, 8, 7]);
    expect(secondWorker.posts[0].transfer).toContain(
      secondRequest.extradata.buffer,
    );

    const packet = new Uint8Array([1, 2, 3, 4]);
    second.decode(packet, 1, 0.9, true);
    expect(secondWorker.posts[1].message).toMatchObject({
      type: "decode",
      pts: 1,
      dts: 0.9,
      keyframe: true,
    });
    expect(secondWorker.posts[1].message.data.buffer).not.toBe(packet.buffer);
    expect(secondWorker.posts[1].transfer).toContain(
      secondWorker.posts[1].message.data.buffer,
    );
    expect(Array.from(packet)).toEqual([1, 2, 3, 4]);
  });

  it("closes a transferred frame that belongs to an older generation", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const decoder = new WorkerSoftwareVideoDecoder();
    const worker = FakeWorker.instances[0];
    await expect(configure(decoder, worker)).resolves.toBe(true);
    const onFrame = vi.fn();
    decoder.setOnFrame(onFrame);
    const oldGeneration = worker.posts[0].message.generation;

    decoder.reset();
    const frame = { close: vi.fn() } as unknown as VideoFrame;
    worker.onmessage?.(
      new MessageEvent("message", {
        data: {
          type: "frame",
          requestId: 9,
          generation: oldGeneration,
          trackId: track.id,
          frame,
        },
      }),
    );

    expect(onFrame).not.toHaveBeenCalled();
    expect(frame.close).toHaveBeenCalledOnce();
    expect(decoder.getStats().droppedStaleMessages).toBe(1);
  });

  it("reports per-packet Worker decode errors to the decoder owner", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const decoder = new WorkerSoftwareVideoDecoder();
    const worker = FakeWorker.instances[0];
    await expect(configure(decoder, worker)).resolves.toBe(true);

    const onError = vi.fn();
    decoder.setOnError(onError);
    decoder.decode(new Uint8Array([1, 2, 3]), 1, 0.9, true);
    const request = worker.posts[1].message;

    worker.onmessage?.(
      new MessageEvent("message", {
        data: {
          type: "error",
          requestId: request.requestId,
          generation: request.generation,
          trackId: request.trackId,
          error: "packet decode failed",
          queueDepth: 1,
          inFlight: 1,
        },
      }),
    );

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toMatchObject({
      message: "packet decode failed",
    });
  });

  it("keeps main-thread backpressure until every submitted packet completes", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const decoder = new WorkerSoftwareVideoDecoder();
    const worker = FakeWorker.instances[0];
    await expect(configure(decoder, worker)).resolves.toBe(true);

    decoder.decode(new Uint8Array([1]), 1, 0.9, true);
    decoder.decode(new Uint8Array([2]), 2, 1.9, false);
    decoder.decode(new Uint8Array([3]), 3, 2.9, false);
    expect(decoder.queueSize).toBe(3);

    const firstRequest = worker.posts[1].message;
    worker.onmessage?.(
      new MessageEvent("message", {
        data: {
          type: "decoded",
          requestId: firstRequest.requestId,
          generation: firstRequest.generation,
          trackId: firstRequest.trackId,
          // A Worker handler can only observe its current call. These local
          // values must not overwrite the main thread's submitted backlog.
          queueDepth: 0,
          inFlight: 0,
        },
      }),
    );

    expect(decoder.getStats()).toMatchObject({
      queueDepth: 2,
      inFlight: 2,
    });
    expect(decoder.queueSize).toBe(2);
  });

  it("settles an in-progress configure when reset cancels its generation", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const decoder = new WorkerSoftwareVideoDecoder();

    const configureResult = decoder.configure(track).then(
      () => "resolved",
      () => "rejected",
    );
    decoder.reset();

    await expect(
      Promise.race([
        configureResult,
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("still-pending"), 0),
        ),
      ]),
    ).resolves.toBe("rejected");
  });

  it("invalidates late frames before closing the Worker", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const decoder = new WorkerSoftwareVideoDecoder();
    const worker = FakeWorker.instances[0];
    await expect(configure(decoder, worker)).resolves.toBe(true);
    const onFrame = vi.fn();
    decoder.setOnFrame(onFrame);
    const oldGeneration = worker.posts[0].message.generation;

    decoder.close();
    const frame = { close: vi.fn() } as unknown as VideoFrame;
    worker.onmessage?.(
      new MessageEvent("message", {
        data: {
          type: "frame",
          requestId: 99,
          generation: oldGeneration,
          trackId: track.id,
          frame,
        },
      }),
    );

    expect(onFrame).not.toHaveBeenCalled();
    expect(frame.close).toHaveBeenCalledOnce();
  });
});
