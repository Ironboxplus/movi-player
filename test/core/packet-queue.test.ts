import { describe, expect, it } from "vitest";
import { PacketQueue } from "../../src/core/PacketQueue";
import type { Packet } from "../../src/types";

function pkt(timestamp: number, size = 10): Packet {
  return {
    streamIndex: 0,
    keyframe: false,
    timestamp,
    dts: timestamp,
    duration: 0.04,
    data: new Uint8Array(size),
    isIdr: false,
    isRasl: false,
    disposable: false,
  };
}

describe("PacketQueue", () => {
  it("is a FIFO that tracks how many bytes it holds", () => {
    const q = new PacketQueue();
    q.push(pkt(1, 100));
    q.push(pkt(1.04, 50));
    expect(q.length).toBe(2);
    expect(q.bytes).toBe(150);
    expect(q.peek()?.timestamp).toBe(1);
    expect(q.shift()?.timestamp).toBe(1);
    expect(q.bytes).toBe(50);
    expect(q.shift()?.timestamp).toBe(1.04);
    expect(q.shift()).toBeUndefined();
    expect(q.length).toBe(0);
    expect(q.bytes).toBe(0);
  });

  it("reports forward seconds as the span from head to tail", () => {
    const q = new PacketQueue();
    expect(q.forwardSeconds()).toBe(0);
    q.push(pkt(10));
    expect(q.forwardSeconds()).toBe(0);
    q.push(pkt(10.5));
    q.push(pkt(12));
    expect(q.firstTimestamp).toBe(10);
    expect(q.lastTimestamp).toBe(12);
    expect(q.forwardSeconds()).toBeCloseTo(2);
    q.shift();
    expect(q.forwardSeconds()).toBeCloseTo(1.5);
  });

  // B-frames arrive in decode order, so a tail packet can carry an earlier
  // timestamp than the one before it. The span must not go negative.
  it("never reports a negative span", () => {
    const q = new PacketQueue();
    q.push(pkt(5));
    q.push(pkt(4.9));
    expect(q.forwardSeconds()).toBe(0);
  });

  it("clear() empties it", () => {
    const q = new PacketQueue();
    for (let i = 0; i < 2000; i++) q.push(pkt(i * 0.01));
    for (let i = 0; i < 1500; i++) q.shift();
    expect(q.length).toBe(500);
    expect(q.peek()?.timestamp).toBeCloseTo(15);
    q.clear();
    expect(q.length).toBe(0);
    expect(q.bytes).toBe(0);
    expect(q.forwardSeconds()).toBe(0);
  });
});
