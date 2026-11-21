export interface Az01Image {
  name: string;
  compatible: string[];
  partition: {
    name: string;
    compression: string;
    hashAlgorithm: string;
    hash: string;
    offset: number;
    size: number;
  };
  eofMarker: boolean;
}
export function parseAz01(bytes: Uint8Array): Az01Image;
export function verifyAz01(
  bytes: Uint8Array,
  parsed?: Az01Image,
): Az01Image & { verified: boolean; actualHash: string };
export function buildAz01(name: string, compatible: string[], payload: Buffer): Buffer;
