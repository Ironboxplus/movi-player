import type { Packet } from "../types";

/**
 * One stream's packets that have been demuxed but not yet handed to its
 * decoder.
 *
 * The player used to push every packet straight into a decoder the moment
 * the demuxer returned it, and read the decoders' queue lengths as the
 * signal to stop reading. That tied every stream to the slowest consumer:
 * a hardware video decoder waiting for output surfaces stopped the reads
 * the audio needed, and a pile of compensations grew up around it. With a
 * queue per stream the demuxer reads into the queues and each decoder takes
 * from its own when it has room, so a full video decoder only stops video
 * being fed (mpv's demux/demux.c packet queues, minus everything this
 * player does not need: no back buffer, no seek ranges, no cache).
 *
 * `forwardSeconds()` is how much media the queue holds ahead of what has
 * been fed. It is measured on timestamps, head to tail; B-frames arrive in
 * decode order, so the tail can sit a frame or two behind its predecessor,
 * which is noise at the seconds scale this is compared against.
 */
export class PacketQueue {
  // A head index instead of Array.shift(): a dense audio codec (TrueHD) can
  // hold thousands of packets, and shifting that array on every feed is a
  // memmove per packet.
  private packets: Packet[] = [];
  private head = 0;
  private _bytes = 0;

  get length(): number {
    return this.packets.length - this.head;
  }

  get bytes(): number {
    return this._bytes;
  }

  get firstTimestamp(): number {
    return this.length > 0 ? this.packets[this.head].timestamp : NaN;
  }

  get lastTimestamp(): number {
    return this.length > 0
      ? this.packets[this.packets.length - 1].timestamp
      : NaN;
  }

  push(packet: Packet): void {
    this.packets.push(packet);
    this._bytes += packet.data.byteLength;
  }

  peek(): Packet | undefined {
    return this.length > 0 ? this.packets[this.head] : undefined;
  }

  shift(): Packet | undefined {
    if (this.length === 0) return undefined;
    const packet = this.packets[this.head];
    this.packets[this.head] = undefined as unknown as Packet;
    this.head++;
    this._bytes -= packet.data.byteLength;
    if (this.head === this.packets.length) {
      this.packets = [];
      this.head = 0;
    } else if (this.head >= 1024 && this.head * 2 >= this.packets.length) {
      this.packets = this.packets.slice(this.head);
      this.head = 0;
    }
    return packet;
  }

  clear(): void {
    this.packets = [];
    this.head = 0;
    this._bytes = 0;
  }

  forwardSeconds(): number {
    if (this.length < 2) return 0;
    return Math.max(0, this.lastTimestamp - this.firstTimestamp);
  }
}
