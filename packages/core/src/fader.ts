// A cubic audio taper: halfway is -18 dB, zero is silent, top is unity.
// Project gains remain linear amplitudes, so existing mixes keep their sound.
export const faderToGain = (position: number) => Math.max(0, Math.min(1, position)) ** 3;
export const gainToFader = (gain: number) => Math.cbrt(Math.max(0, Math.min(1, gain)));
export const gainLabel = (gain: number) =>
  gain <= 0 ? "−∞ dB" : `${(20 * Math.log10(gain)).toFixed(1)} dB`;
