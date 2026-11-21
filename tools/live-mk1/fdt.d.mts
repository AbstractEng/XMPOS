export interface FdtNode {
  name: string;
  properties: Map<string, Buffer>;
  children: FdtNode[];
}
export function parseDtb(bytes: Uint8Array): FdtNode;
export function strings(value: Buffer | undefined): string[];
export function text(value: Buffer | undefined): string | null;
export function u32(value: Buffer | undefined): number | null;
export function walk(node: FdtNode, path?: string): Generator<{ path: string; node: FdtNode }>;
export function findByCompatible(
  root: FdtNode,
  compatible: string,
): { path: string; node: FdtNode }[];
export function findByPrefix(root: FdtNode, prefix: string): { path: string; node: FdtNode }[];
export function hubStrings(bytes: Uint8Array): string[];
