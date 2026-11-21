export const voiceSettings: {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
  speed: number;
};
export function spokenSegments(segments: readonly string[]): string[];
export function narrationRequest(segments: readonly string[]): {
  text: string;
  model_id: string;
  voice_settings: typeof voiceSettings;
};
export function narrationFingerprint(segments: readonly string[]): string;
export function verifyNarration(
  lesson: {
    id: string;
    steps: ReadonlyArray<ReadonlyArray<unknown> | { speech: string }>;
  },
  metadata?: { scriptSha256?: string } | null,
): void;
