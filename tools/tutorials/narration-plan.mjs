import { createHash } from "node:crypto";
export const voiceSettings = {
  stability: 0.45,
  similarity_boost: 0.8,
  style: 0.12,
  use_speaker_boost: true,
  speed: 1.05,
};
// Match the private narrator's existing Python json.dumps(sort_keys=True) receipts.
function pythonJson(value) {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${pythonJson(key)}: ${pythonJson(value[key])}`)
      .join(", ")}}`;
  return JSON.stringify(value).replace(
    /[\u0080-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
// The instrument's name rhymes with "five". Keep the printed spelling in the
// guide and captions; only the speech request uses an unambiguous spelling.
// Lowercase "live" in "where projects live" remains the ordinary verb.
export function spokenSegments(segments) {
  return segments.map((segment) => segment.replace(/\bLive\b/g, "Lyve"));
}
export function narrationRequest(segments) {
  return {
    text: spokenSegments(segments).join("\n\n"),
    model_id: "eleven_multilingual_v2",
    voice_settings: voiceSettings,
  };
}
export function narrationFingerprint(segments) {
  const request = narrationRequest(segments);
  return createHash("sha256").update(pythonJson(request)).digest("hex");
}
export function verifyNarration(lesson, metadata) {
  const segments = lesson.steps.map((step) => (Array.isArray(step) ? step[4] : step.speech));
  if (metadata?.scriptSha256 !== narrationFingerprint(segments))
    throw new Error(
      `${lesson.id}: narration is missing or stale; regenerate the changed script before recording`,
    );
}
