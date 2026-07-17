/**
 * Converts compressed-packet timestamps into a continuous PCM timeline.
 *
 * FFmpeg can emit several decoded audio frames for one packet. Those frames
 * share the packet timestamp but each has its own sample duration, so handing
 * the packet timestamp to every frame makes Web Audio repeatedly seek back in
 * time. The decoder API used by the worker does not expose per-frame PTS; use
 * the packet PTS only as an anchor and advance subsequent output by samples.
 */
export class PCMFrameTimestampClock {
  private static readonly FORWARD_DISCONTINUITY_US = 250_000;

  private nextTimestampUs: number | null = null;

  reset(): void {
    this.nextTimestampUs = null;
  }

  next(
    packetTimestampSeconds: number,
    numberOfFrames: number,
    sampleRate: number,
  ): number {
    const packetTimestampUs = packetTimestampSeconds * 1_000_000;
    const durationUs = (numberOfFrames / sampleRate) * 1_000_000;

    if (
      !Number.isFinite(packetTimestampUs) ||
      !Number.isFinite(durationUs) ||
      durationUs <= 0
    ) {
      return this.nextTimestampUs ?? 0;
    }

    if (
      this.nextTimestampUs === null ||
      packetTimestampUs >
        this.nextTimestampUs +
          PCMFrameTimestampClock.FORWARD_DISCONTINUITY_US
    ) {
      this.nextTimestampUs = packetTimestampUs;
    }

    const timestamp = this.nextTimestampUs;
    this.nextTimestampUs += durationUs;
    return timestamp;
  }
}
