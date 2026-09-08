import type { AudioTrack } from "../types";
import { Logger } from "../utils/Logger";
import { SoftwareAudioDecoder, type PCMFrame } from "./SoftwareAudioDecoder";
import {
  WorkerSoftwareAudioDecoder,
  type AudioWorkerStats,
} from "./WorkerSoftwareAudioDecoder";
import { WasmBindings } from "../wasm/bindings";

const TAG = "AudioDecoder";

export class MoviAudioDecoder {
  private decoder: AudioDecoder | null = null;
  private swDecoder: SoftwareAudioDecoder | WorkerSoftwareAudioDecoder | null =
    null;
  private bindings: WasmBindings | null = null;
  private useSoftware: boolean = false;

  private pendingData: AudioData[] = [];
  private pendingPCM: PCMFrame[] = [];
  private pendingChunks: Array<{
    data: Uint8Array;
    timestamp: number;
    keyframe: boolean;
  }> = [];
  private isConfigured: boolean = false;
  private onData: ((data: AudioData) => void) | null = null;
  private onPCM: ((frame: PCMFrame) => void) | null = null;
  private onError: ((error: Error) => void) | null = null;
  private onBroken: (() => void) | null = null;
  private currentExtradata: Uint8Array | undefined = undefined;
  // How many PCM frames the CURRENT software decoder has produced, and how many
  // times we've reverted it. A fallback that decodes nothing is worse than the
  // hardware decoder it replaced — see the revert in initSoftwareDecoder.
  private swFramesProduced = 0;
  private swRevertAttempts = 0;
  private static readonly MAX_SW_REVERTS = 2;
  private currentTrack: AudioTrack | null = null;
  private hasTriedSoftwareFallback: boolean = false; // Track if we've already tried software fallback
  private hasDescription: boolean = false; // Whether decoder was configured with description (AudioSpecificConfig)
  private softwareFallbackReason = "";
  // Stereo downmix policy for the software path (truehd, dca, ac3,
  // eac3, …). Defaults to stereo so headphones / laptop speakers
  // sound right; flipped off by setDownmix() when the player has
  // confirmed the output destination supports the source's full
  // channel count. WebCodecs path is unaffected — the browser
  // delivers AudioData at the source channel count and the AudioRenderer
  // either passes it through (if destination.channelCount matches)
  // or lets Web Audio do its own downmix.
  private _downmix = true;

  constructor() {
    Logger.debug(TAG, "Created");
  }

  setDownmix(downmix: boolean): void {
    this._downmix = downmix;
    if (this.swDecoder) this.swDecoder.setDownmix(downmix);
  }

  setBindings(bindings: WasmBindings) {
    this.bindings = bindings;
  }

  /** True when audio runs through the WASM software decoder (TrueHD/DTS/AC-3/
   *  Opus/FLAC/…) rather than WebCodecs. The software path decodes sub-realtime
   *  on a cold start, so callers can gate cold-start mitigations on this. */
  get usesSoftware(): boolean {
    return this.useSoftware;
  }

  /**
   * Configure the decoder for a specific track
   */
  async configure(track: AudioTrack, extradata?: Uint8Array): Promise<boolean> {
    // Embed extradata onto currentTrack itself: configureSoftwareDecoder()
    // passes this object straight to decoder.configure(), and
    // SoftwareAudioDecoder.configure() reads track.extradata to call
    // bindings.enableDecoder(trackIndex, track.extradata) (A4) — the software
    // decoder never sees the extradata parameter otherwise.
    this.currentTrack =
      extradata && extradata.length > 0 ? { ...track, extradata } : track;
    // Kept separately (not just as currentTrack.extradata) so
    // handleSoftwareBroken()'s revert-and-retry always has the original
    // configure-time extradata to hand back, independent of whatever the
    // fallback path did to currentTrack in between.
    this.currentExtradata = extradata;
    this.useSoftware = false;
    this.softwareFallbackReason = "";
    this.hasTriedSoftwareFallback = false; // Reset fallback flag on new configuration
    this.swFramesProduced = 0;

    if (this.swDecoder) {
      this.swDecoder.close();
      this.swDecoder = null;
    }

    // Check if we should force software decoding for this codec
    if (this.needsSoftwareDecoding(track.codec)) {
      Logger.info(TAG, `Forcing software decoding for codec: ${track.codec}`);
      return this.initSoftwareDecoder();
    }

    // Force software decoding for multi-channel audio (> 2 channels)
    // Safari and some browsers have issues with > 2 channels WebCodecs decoding
    if (track.channels > 2) {
      Logger.info(
        TAG,
        `Forcing software decoding for multi-channel audio: ${track.channels} channels`,
      );
      return this.initSoftwareDecoder();
    }

    if (!("AudioDecoder" in window)) {
      Logger.error(TAG, "WebCodecs AudioDecoder not supported");
      return this.initSoftwareDecoder();
    }

    // Map codec names to WebCodecs codec strings
    const codecString = this.mapCodecToWebCodecs(track.codec);
    if (!codecString) {
      Logger.warn(
        TAG,
        `Codec ${track.codec} not natively supported, trying software.`,
      );
      return this.initSoftwareDecoder();
    }

    // Build config object
    const config: AudioDecoderConfig = {
      codec: codecString,
      sampleRate: track.sampleRate,
      numberOfChannels: track.channels,
    };

    // Add description (extradata) if available
    this.hasDescription = false;
    if (extradata && extradata.length > 0) {
      config.description = extradata;
      this.hasDescription = true;
    }

    // Check if codec is supported
    try {
      const support = await AudioDecoder.isConfigSupported(config);

      if (!support.supported) {
        Logger.warn(
          TAG,
          `Codec not supported by hardware: ${codecString}. Trying software.`,
        );
        return this.initSoftwareDecoder();
      }
    } catch (error) {
      Logger.warn(TAG, `Codec config check failed: ${codecString}`, error);
      return this.initSoftwareDecoder();
    }

    // Create decoder
    this.decoder = new AudioDecoder({
      output: (data) => {
        if (this.onData) {
          this.onData(data);
        } else {
          this.pendingData.push(data);
        }
      },
      error: async (error) => {
        Logger.error(TAG, "Decoder error", error);

        // Automatically fallback to software decoder if not already using it
        if (
          !this.useSoftware &&
          !this.hasTriedSoftwareFallback &&
          this.currentTrack
        ) {
          Logger.warn(
            TAG,
            "Hardware decoder error detected, automatically switching to software decoder",
          );
          this.hasTriedSoftwareFallback = true;

          // Try to switch to software decoder
          const switched = await this.initSoftwareDecoder();
          if (switched) {
            Logger.info(
              TAG,
              "Successfully switched to software decoder after hardware error",
            );
            // Don't call onError if we successfully switched - the error is handled
            return;
          } else {
            Logger.error(
              TAG,
              "Failed to switch to software decoder, error will be propagated",
            );
          }
        }

        // Call error callback if we couldn't switch or already using software
        if (this.onError) {
          this.onError(error);
        }
      },
    });

    // Configure decoder
    try {
      this.decoder.configure(config);
      this.isConfigured = true;
      Logger.info(
        TAG,
        `Configured: ${codecString} ${track.sampleRate}Hz ${track.channels}ch`,
      );
      return true;
    } catch (error) {
      Logger.error(TAG, "Failed to configure decoder", error);
      return this.initSoftwareDecoder();
    }
  }

  /**
   * Every codec, in software. FFmpeg WASM decodes all of them; WebCodecs is no
   * longer asked for any.
   *
   * It used to be a list — eac3, ac3, dts, dca, truehd, mlp, opus, flac — each
   * added after its own WebCodecs failure: packet gaps it choked on, a FLAC
   * description it would not accept, channel layouts it dropped. What that list
   * really recorded is that the browser's audio decoders disagree with each
   * other and with the demuxer feeding them, and that every disagreement was
   * found by a user hearing it rather than by a test.
   *
   * The split had a second cost that only showed up once audio gained a
   * bitrate ladder: with AAC native and opus in WASM, choosing a rung meant
   * choosing a decoder, so a cheaper stream could cost more CPU than the
   * expensive one and the ladder could not simply follow the link. One path
   * makes bitrate the only variable again.
   *
   * The price is real and worth saying: AAC now decodes in WASM rather than in
   * the browser's own code, which is more CPU per packet on exactly the phones
   * where audio is already tight. Multi-channel and the error path came here
   * anyway, so this is the same code that was already carrying the hard cases.
   */
  private needsSoftwareDecoding(_codec: string): boolean {
    return true;
  }

  /**
   * The software decoder's circuit-breaker tripped (SoftwareAudioDecoder:
   * MAX_CONSECUTIVE_FAILURES packets rejected in a row; the worker path trips
   * the same way — see MAX_CONSECUTIVE_FAILURES in
   * SoftwareAudioDecoder.worker.ts). Both decoder types call this through the
   * onBroken hook wired in configureSoftwareDecoder (A2/A5).
   *
   * Since A5 (needsSoftwareDecoding() is now unconditionally true) there is
   * no hardware WebCodecs decoder left to revert to for any codec — this
   * used to fall back FROM hardware TO software, and reverting meant undoing
   * that. Now every configure() routes straight back into
   * initSoftwareDecoder(), so "revert" means: tear down the broken decoder
   * instance and build a fresh one (worker-first again, per
   * createSoftwareDecoder()). That's still worth doing — the corruption is
   * often in decoder-side WASM/worker state, not the codec itself — but it's
   * bounded by MAX_SW_REVERTS so a genuinely unplayable stream doesn't loop.
   *
   * If the decoder never produced a single frame, the fresh instance is
   * worth trying (seen in the wild: `sendPacket failed: -1094995529`
   * repeating for the rest of the video, with a manual seek only resetting
   * the counter so it could fail another 50 times). If it HAD been producing
   * audio, the stream is just out of step — leave it in place and let the
   * owner's re-align (onBroken below) handle it instead of discarding a
   * decoder that was working.
   */
  private handleSoftwareBroken(): void {
    const producedNothing = this.swFramesProduced === 0;
    if (
      producedNothing &&
      this.currentTrack &&
      this.swRevertAttempts < MoviAudioDecoder.MAX_SW_REVERTS
    ) {
      this.swRevertAttempts++;
      Logger.warn(
        TAG,
        `Software decoder produced nothing before breaking — rebuilding it fresh (attempt ${this.swRevertAttempts})`,
      );
      const track = this.currentTrack;
      const extradata = this.currentExtradata;
      if (this.swDecoder) {
        this.swDecoder.close();
        this.swDecoder = null;
      }
      this.useSoftware = false;
      // configure() resets hasTriedSoftwareFallback (used by the dormant
      // hardware path below) and swFramesProduced, so a fresh instance gets
      // a clean attempt — just not more than MAX_SW_REVERTS times.
      void this.configure(track, extradata).then((ok) => {
        if (!ok) {
          Logger.error(TAG, "Software decoder re-configure after revert failed");
        }
      });
    }
    // Either way the owner should re-align the audio source at the playhead.
    this.onBroken?.();
  }

  private async initSoftwareDecoder(): Promise<boolean> {
    if (!this.currentTrack) return false;
    if (!this.bindings) {
      Logger.error(
        TAG,
        "Cannot switch to software decoder: bindings not available",
      );
      return false;
    }

    Logger.info(TAG, "Initializing software decoder fallback");
    this.useSoftware = true;

    if (this.decoder) {
      try {
        this.decoder.close();
      } catch (e) {}
      this.decoder = null;
    }

    // Worker-first, main-thread fallback (createSoftwareDecoder), with a
    // second fallback here if the worker decoder is created but fails to
    // CONFIGURE (vs. fails to even construct, which createSoftwareDecoder
    // already handles). configureSoftwareDecoder wires onData/onError/
    // onBroken/downmix identically for either decoder type (A2/A5).
    const decoder = await this.createSoftwareDecoder();
    if (!decoder) return false;

    let success = await this.configureSoftwareDecoder(decoder);
    if (!success && decoder instanceof WorkerSoftwareAudioDecoder && this.bindings) {
      const workerStats = decoder.getStats();
      this.softwareFallbackReason =
        workerStats.lastError ||
        `Worker configure returned false (${workerStats.configureState})`;
      decoder.close();
      Logger.warn(
        TAG,
        `Worker software audio decoder unavailable, falling back to main thread: ${this.softwareFallbackReason}`,
      );
      success = await this.configureSoftwareDecoder(
        new SoftwareAudioDecoder(this.bindings),
      );
    }

    if (success) {
      this.isConfigured = true;

      // Process pending chunks
      if (this.pendingChunks.length > 0) {
        const chunks = [...this.pendingChunks];
        this.pendingChunks = [];
        for (const chunk of chunks) {
          this.decode(chunk.data, chunk.timestamp, chunk.keyframe);
        }
      }
      return true;
    }
    return false;
  }

  private async configureSoftwareDecoder(
    decoder: SoftwareAudioDecoder | WorkerSoftwareAudioDecoder,
  ): Promise<boolean> {
    if (!this.currentTrack) return false;

    this.swDecoder = decoder;
    // Carry forward the player-set downmix policy so a fresh swDecoder
    // (e.g. an audio-track switch) doesn't snap back to stereo while
    // the renderer is still wired for multi-channel output.
    decoder.setDownmix(this._downmix);
    decoder.setOnData((frame) => {
      // Counts frames from THIS decoder instance (reset to 0 in configure());
      // handleSoftwareBroken() reads it to tell "misaligned stream, already
      // producing audio" apart from "this decoder never worked at all".
      this.swFramesProduced++;
      if (this.onPCM) this.onPCM(frame);
      else this.pendingPCM.push(frame);
    });
    decoder.setOnError((e) => {
      Logger.error(TAG, "Software decoder error", e);
      if (this.onError) this.onError(e);
    });
    // Wired identically for SoftwareAudioDecoder (main-thread circuit-breaker)
    // and WorkerSoftwareAudioDecoder (worker circuit-breaker) — both classes
    // implement setOnBroken with the same contract, so handleSoftwareBroken's
    // revert-and-retry engages no matter which one this codec/browser landed
    // on. Without this the worker path (primary since A5) never recovers
    // from a tripped breaker and audio just stays silent.
    decoder.setOnBroken(() => this.handleSoftwareBroken());

    try {
      return await decoder.configure(this.currentTrack);
    } catch (error) {
      Logger.warn(TAG, "Software decoder configure failed", error);
      return false;
    }
  }

  private async createSoftwareDecoder(): Promise<
    SoftwareAudioDecoder | WorkerSoftwareAudioDecoder | null
  > {
    if (WorkerSoftwareAudioDecoder.isSupported()) {
      try {
        const workerDecoder = new WorkerSoftwareAudioDecoder();
        Logger.info(TAG, "Using worker software audio decoder");
        return workerDecoder;
      } catch (error) {
        this.softwareFallbackReason =
          error instanceof Error ? error.message : String(error);
        Logger.warn(
          TAG,
          "Worker software audio decoder failed, falling back to main thread",
          error,
        );
      }
    }

    if (!this.bindings) return null;
    return new SoftwareAudioDecoder(this.bindings);
  }

  /**
   * Map FFmpeg codec names to WebCodecs codec strings
   */
  private mapCodecToWebCodecs(codec: string): string | null {
    const codecLower = codec.toLowerCase();

    // AAC
    if (codecLower === "aac" || codecLower === "aac_latm") {
      return "mp4a.40.2"; // AAC-LC
    }

    // MP3
    if (codecLower === "mp3") {
      return "mp3";
    }

    // Opus - although in transcoding list, some browsers might support it natively
    if (codecLower === "opus") {
      return "opus";
    }

    // Vorbis
    if (codecLower === "vorbis") {
      return "vorbis";
    }

    // FLAC
    if (codecLower === "flac") {
      return "flac";
    }

    // AMR-NB
    if (codecLower === "amr_nb" || codecLower === "amrnb") {
      return "samr";
    }

    // AMR-WB
    if (codecLower === "amr_wb" || codecLower === "amrwb") {
      return "sawb";
    }

    // AC3 / E-AC3
    if (codecLower === "ac3") {
      return "ac-3";
    }
    if (codecLower === "eac3" || codecLower === "ec3") {
      return "ec-3";
    }

    return null;
  }

  /**
   * Decode an encoded audio chunk
   */
  /**
   * True while packets are going through the WASM software decoder, i.e. when
   * decodeBatch() is worth using. Codecs that land here (TrueHD/MLP/DTS) emit
   * very small access units, so the per-packet round-trip dominates.
   */
  canBatch(): boolean {
    return (
      this.isConfigured &&
      this.useSoftware &&
      // The fork normally uses WorkerSoftwareAudioDecoder. Its transport keeps
      // the native-frame/PCM ABI off the main thread and deliberately does not
      // use upstream's split-audio batch ABI. The legacy main-thread decoder
      // may opt in only when a matching WASM module actually exports it.
      this.swDecoder instanceof SoftwareAudioDecoder &&
      // A .wasm older than this bundle has no batch exports — decode per packet
      // rather than calling into undefined and losing audio outright.
      !!this.bindings?.supportsAudioBatch()
    );
  }

  /**
   * Decode a run of packets in as few WASM round-trips as possible. Only the
   * software path actually batches; WebCodecs has no such cost (and its own
   * queue), so it just replays them one by one. Returns packets consumed —
   * always all of them unless the software batch stopped early (format change
   * or pts discontinuity), in which case the caller re-submits the rest.
   */
  decodeBatch(packets: { data: Uint8Array; pts: number }[]): number {
    if (packets.length === 0) return 0;
    if (!this.canBatch()) {
      for (const p of packets) this.decode(p.data, p.pts, true);
      return packets.length;
    }
    // canBatch() above narrows this to the legacy main-thread implementation.
    // Keep the guard here as well: decoder teardown can race a queued submit.
    if (this.swDecoder instanceof SoftwareAudioDecoder) {
      return this.swDecoder.decodeBatch(packets);
    }
    for (const p of packets) this.decode(p.data, p.pts, true);
    return packets.length;
  }

  decode(data: Uint8Array, timestamp: number, keyframe: boolean): void {
    if (!this.isConfigured) {
      this.pendingChunks.push({ data, timestamp, keyframe });
      return;
    }

    if (this.useSoftware && this.swDecoder) {
      this.swDecoder.decode(data, timestamp, keyframe);
      return;
    }

    if (!this.decoder) {
      Logger.warn(TAG, "Decoder not configured");
      return;
    }

    // Check if decoder is in a valid state
    if (this.decoder.state === "closed") {
      Logger.warn(TAG, "Decoder is closed, cannot decode");
      return;
    }

    // Strip ADTS header if present and decoder has description (AudioSpecificConfig).
    // MPEG-TS containers deliver AAC as ADTS frames, but when WebCodecs has description
    // it expects raw AAC frames without ADTS headers.
    const chunkData = this.hasDescription
      ? MoviAudioDecoder.stripAdtsHeader(data)
      : data;

    const chunk = new EncodedAudioChunk({
      type: keyframe ? "key" : "delta",
      timestamp: timestamp * 1_000_000, // Convert to microseconds
      data: chunkData,
    });

    try {
      this.decoder.decode(chunk);
    } catch (error) {
      Logger.error(TAG, "Decode error", error);

      // Automatically fallback to software decoder if not already using it
      if (
        !this.useSoftware &&
        !this.hasTriedSoftwareFallback &&
        this.currentTrack
      ) {
        Logger.warn(
          TAG,
          "Decode exception detected, automatically switching to software decoder",
        );
        this.hasTriedSoftwareFallback = true;

        // Add current chunk to pending chunks so it gets processed after switch
        this.pendingChunks.push({ data, timestamp, keyframe });

        // Try to switch to software decoder
        this.initSoftwareDecoder()
          .then((switched) => {
            if (switched) {
              Logger.info(
                TAG,
                "Successfully switched to software decoder after decode exception",
              );
              // Pending chunks will be processed by initSoftwareDecoder
            } else {
              Logger.error(TAG, "Failed to switch to software decoder");
              // Mark as not configured to stop further decode attempts
              this.isConfigured = false;
            }
          })
          .catch((err) => {
            Logger.error(TAG, "Error during software decoder fallback", err);
            this.isConfigured = false;
          });
        return;
      }

      // Mark as not configured to stop further decode attempts
      this.isConfigured = false;
    }
  }

  /**
   * Set data output callback
   */
  setOnData(callback: (data: AudioData) => void): void {
    this.onData = callback;

    // Flush any pending data
    while (this.pendingData.length > 0) {
      const data = this.pendingData.shift()!;
      callback(data);
    }
  }

  /**
   * Set PCM frame output callback (used by the software decoder path).
   */
  setOnPCM(callback: (frame: PCMFrame) => void): void {
    this.onPCM = callback;

    while (this.pendingPCM.length > 0) {
      const frame = this.pendingPCM.shift()!;
      callback(frame);
    }
  }

  /**
   * Set error callback
   */
  setOnError(callback: (error: Error) => void): void {
    this.onError = callback;
  }

  /**
   * Fires when the software decoder's failure circuit-breaker trips — every
   * packet is being rejected and audio has gone silent. The owner is expected
   * to re-align the audio source (seek it back to the playhead) and flush,
   * which clears the breaker; a manual seek did exactly that by accident.
   */
  setOnBroken(callback: () => void): void {
    this.onBroken = callback;
  }

  /**
   * Flush the decoder
   */
  async flush(): Promise<void> {
    // Software path (TrueHD/DTS/Opus/FLAC/…): the WebCodecs `decoder` is null,
    // so flush the WASM decoder instead. Skipping this leaves stale decoder
    // state across a seek/replay — TrueHD then rejects packets (sendPacket →
    // AVERROR_INVALIDDATA) until the next major-sync, an audible buzz/dropout.
    // Our swDecoder may be the off-thread WorkerSoftwareAudioDecoder — its
    // flush() forwards to the worker, so this path is correct for both.
    if (this.useSoftware && this.swDecoder) {
      await this.swDecoder.flush();
      return;
    }
    if (!this.decoder) return;

    try {
      await this.decoder.flush();
    } catch (error) {
      Logger.error(TAG, "Flush error", error);
    }
  }

  /**
   * Reset the decoder
   */
  reset(): void {
    if (this.useSoftware && this.swDecoder) {
      this.swDecoder.reset();
    }

    if (this.decoder) {
      try {
        this.decoder.reset();
      } catch (error) {
        Logger.error(TAG, "Reset error", error);
      }
    }

    // Close pending data
    for (const data of this.pendingData) {
      data.close();
    }
    this.pendingData = [];
    this.pendingPCM = [];
  }

  /**
   * Close the decoder
   */
  close(): void {
    this.reset();

    if (this.swDecoder) {
      this.swDecoder.close();
      this.swDecoder = null;
    }

    if (this.decoder) {
      try {
        this.decoder.close();
      } catch (error) {
        // Ignore close errors
      }
      this.decoder = null;
    }

    this.isConfigured = false;
    this.onData = null;
    this.onError = null;

    Logger.debug(TAG, "Closed");
  }

  /**
   * Check if decoder is configured
   */
  get configured(): boolean {
    return this.isConfigured;
  }

  /**
   * Get queue size
   */
  get queueSize(): number {
    return (this.swDecoder?.queueSize ?? 0) + (this.decoder?.decodeQueueSize ?? 0);
  }

  /**
   * Check if software decoder is being used
   */
  get isSoftware(): boolean {
    return this.useSoftware;
  }

  /**
   * Get decoder stats for nerd stats overlay
   */
  getStats(): {
    decoderType: string;
    queueSize: number;
    isSoftware: boolean;
    softwareFallbackReason: string;
    worker?: AudioWorkerStats;
  } {
    const worker =
      this.swDecoder instanceof WorkerSoftwareAudioDecoder
        ? this.swDecoder.getStats()
        : undefined;

    return {
      decoderType: this.useSoftware
        ? worker
          ? "Software (FFmpeg Worker)"
          : "Software (FFmpeg)"
        : "Hardware (WebCodecs)",
      queueSize: this.queueSize,
      isSoftware: this.useSoftware,
      softwareFallbackReason: this.softwareFallbackReason,
      worker,
    };
  }

  /**
   * Strip ADTS header from AAC packet data if present.
   * ADTS header is 7 bytes (without CRC) or 9 bytes (with CRC).
   * Sync word: 0xFFF (12 bits).
   */
  private static stripAdtsHeader(data: Uint8Array): Uint8Array {
    if (data.length < 7) return data;

    // Check ADTS sync word (0xFFF = 12 bits)
    if (data[0] !== 0xff || (data[1] & 0xf0) !== 0xf0) {
      return data; // Not ADTS, return as-is
    }

    // protection_absent flag (bit 0 of byte 1): 1 = no CRC, 0 = CRC present
    const protectionAbsent = data[1] & 0x01;
    const headerSize = protectionAbsent ? 7 : 9;

    // ADTS frame length is in bits 30-42 (13 bits) spanning bytes 3-5
    const frameLength =
      ((data[3] & 0x03) << 11) | (data[4] << 3) | ((data[5] & 0xe0) >> 5);

    // Sanity check: frame length should match data length (or be close)
    if (frameLength > 0 && frameLength <= data.length && headerSize < data.length) {
      return data.subarray(headerSize, frameLength);
    }

    // If frame length doesn't match, just strip the header
    if (headerSize < data.length) {
      return data.subarray(headerSize);
    }

    return data;
  }
}
