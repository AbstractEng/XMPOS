export interface KitPad {
  pad: number;
  name: string;
  source: string;
  seconds: number;
  peak: number;
  tune?: number;
  choke?: number;
}
export interface PickedLayer {
  vl: number;
  takes: { path: string; rr: number }[];
}
export const PADS: KitPad[];
export function pickLayers(paths: string[], source: string, mic?: string): PickedLayer[];
export function shape(samples: Float32Array, seconds: number): Float32Array;
export function wav24(samples: Float32Array, gain: number): Buffer;
export function folderName(pad: KitPad): string;
export const MIXES: Record<string, Record<string, number>>;
export function onMic(path: string, from: string, to: string): string;
export function mixDown(parts: [Float32Array, number][]): Float32Array;
export function retune(samples: Float32Array, semitones: number): Float32Array;
export function saturate(samples: Float32Array, drive: number, reference: number): Float32Array;
