// Independent musical oracle: 120 BPM, 48 kHz, eighth-note pairs = 12000 frames.
// Ratio percentages describe the first sixteenth's share of that pair.
export const grooveOracle = Object.freeze({
  bpm: 120,
  sampleRate: 48000,
  barFrames: 96000,
  cases: [
    { percent: 50, frame: 6000 },
    { percent: 62, frame: 7440 },
    { percent: 75, frame: 9000 },
  ],
  tripletFrame: 8000,
});
