export interface DecodeModeProbe {
  isSoftware?: boolean;
}

export interface DecodeMode {
  videoSoftware: boolean;
  audioSoftware: boolean;
  softwareHeavy: boolean;
}

export function getDecodeMode(
  videoDecoder: DecodeModeProbe | null | undefined,
  audioDecoder: DecodeModeProbe | null | undefined,
): DecodeMode {
  const videoSoftware = Boolean(videoDecoder?.isSoftware);
  const audioSoftware = Boolean(audioDecoder?.isSoftware);
  return {
    videoSoftware,
    audioSoftware,
    softwareHeavy: videoSoftware || audioSoftware,
  };
}

export function isSoftwareDecodePath(
  videoDecoder: DecodeModeProbe | null | undefined,
  audioDecoder: DecodeModeProbe | null | undefined,
): boolean {
  return getDecodeMode(videoDecoder, audioDecoder).softwareHeavy;
}
