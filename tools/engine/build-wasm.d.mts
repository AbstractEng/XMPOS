export interface WasmModule {
  name: string;
  prefix: string;
  main: string;
  sources: string[];
  output: string;
}
export const MODULES: WasmModule[];
export const SOURCES: string[];
export const OUTPUT: string;
export function sourceHash(module?: WasmModule): Promise<string>;
